"""取得官方免费三维源包；原包与解压文件留在本地，清单可提交审核。"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
from html import unescape
from html.parser import HTMLParser
import http.cookiejar
import io
import json
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / '.local/3d-sources/provider-packs'
DEFAULT_MANIFEST = ROOT / 'internal/assets/provider-pack-manifest.json'
MODEL_EXTENSIONS = {'.glb', '.gltf', '.fbx', '.obj', '.dae', '.stl', '.blend'}
USER_AGENT = 'Mozilla/5.0 (compatible; GrowthCamp asset preparation)'


# 页面节点只保留筛选上传文件所需的标签、属性、文本及子节点。
class Element:
    # 建立一个轻量 HTML 节点。
    def __init__(self, tag='', attributes=None):
        self.tag = tag  # 原始 HTML 标签。
        self.attributes = attributes or {}  # 官方页面中的属性。
        self.children = []  # 子标签和文字。

    # 遍历当前节点及后代。
    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Element):
                yield from child.walk()

    # 取得节点内可见文字。
    def text(self):
        return ''.join(child.text() if isinstance(child, Element) else child for child in self.children).strip()


# 官方 HTML 允许未闭合的 void 标签，解析时不会把后续节点嵌入其中。
class Document(HTMLParser):
    # 初始化页面树。
    def __init__(self, markup):
        super().__init__(convert_charrefs=True)
        self.root = Element()  # 整个页面的根节点。
        self.stack = [self.root]  # 当前标签路径。
        self.feed(markup)

    # 接收标签并维护其原始嵌套关系。
    def handle_starttag(self, tag, attributes):
        node = Element(tag, dict(attributes))
        self.stack[-1].children.append(node)
        if tag not in {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}:
            self.stack.append(node)

    # 结束标签时允许浏览器通常能够恢复的 HTML 省略。
    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    # 保存元素文字。
    def handle_data(self, data):
        self.stack[-1].children.append(data)


# 目录导航和重复卡片不属于素材包。
def catalog_urls(markup, provider):
    pattern = r'https://kenney\.nl/assets/[a-z0-9-]+' if provider == 'kenney' else r'https://kaylousberg\.itch\.io/[a-z0-9-]+'
    urls = set()
    for node in Document(markup).root.walk():
        url = node.attributes.get('href', '')
        if re.fullmatch(pattern, url):
            urls.add(url)
    return sorted(urls)


# 只选择免费会话实际获得的下载按钮，付费锁定文件没有此属性。
def itch_uploads(markup):
    uploads = []
    for node in Document(markup).root.walk():
        if 'upload' not in node.attributes.get('class', '').split():
            continue
        descendants = list(node.walk())
        button = next((item for item in descendants if item.attributes.get('data-upload_id')), None)
        if button is None:
            continue
        name = next((item for item in descendants if 'name' in item.attributes.get('class', '').split()), None)
        uploads.append({'id': button.attributes['data-upload_id'], 'name': name.text() if name else button.attributes['data-upload_id']})
    return uploads


# 原包解压仅写入该包的专用目录。
def extract_archive(archive, destination):
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            target = (destination / member.filename).resolve()
            if destination.resolve() != target and destination.resolve() not in target.parents:
                raise ValueError('源包存在越过解压目录的路径')
        source.extractall(destination)


# 统计源格式，图片和二进制依赖不计入模型数量。
def model_formats(directory):
    return dict(sorted(Counter(path.suffix.lower() for path in directory.rglob('*') if path.is_file() and path.suffix.lower() in MODEL_EXTENSIONS).items()))


# 每个包独占 CookieJar，避免并行请求混用官方免费会话。
def session():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


# 请求失败可重试，签名链接只用于本次下载，不作为长期素材身份。
def request(opener, url, data=None, referer=None):
    headers = {'User-Agent': USER_AGENT}
    if referer:
        headers['Referer'] = referer
    if data is not None:
        headers['X-Requested-With'] = 'XMLHttpRequest'
        data = urllib.parse.urlencode(data).encode()
    for attempt in range(3):
        try:
            with opener.open(urllib.request.Request(url, data=data, headers=headers), timeout=90) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


# 标题来自官方页面，不在抓取代码内复制各包的展示文案。
def page_title(markup):
    match = re.search(r'<title>(.*?)</title>', markup, re.S)
    return unescape(re.sub(r'\s+', ' ', match.group(1))).split(' by Kay Lousberg')[0].split(' · Kenney')[0].split(' &middot; Kenney')[0].strip() if match else ''


# 官方目录的分页链接决定边界，不把固定页数当作未来目录契约。
def discover_kenney():
    root = 'https://kenney.nl/assets/category:3D'
    opener = session()
    first = request(opener, root).decode()
    page_urls = {root}
    for node in Document(first).root.walk():
        url = node.attributes.get('href', '')
        if re.fullmatch(re.escape(root) + r'/page:\d+', url):
            page_urls.add(url)
    urls = set(catalog_urls(first, 'kenney'))
    for url in sorted(page_urls - {root}):
        urls.update(catalog_urls(request(opener, url).decode(), 'kenney'))
    return sorted(urls), sorted(page_urls)


# KayKit 作者目录同时列出免费包和付费包，是否免费在包页判断。
def discover_kaykit():
    url = 'https://kaylousberg.itch.io/'
    return catalog_urls(request(session(), url).decode(), 'kaykit'), [url]


# 保存原始源包并记录实际字节；重复执行复用已完整取得的压缩包。
def download_archive(opener, url, archive, referer):
    if not archive.exists():
        data = request(opener, url, referer=referer)
        if not zipfile.is_zipfile(io.BytesIO(data)):
            raise ValueError('下载结果不是 ZIP 源包')
        archive.parent.mkdir(parents=True, exist_ok=True)
        temporary = archive.with_suffix('.partial')
        temporary.write_bytes(data)
        temporary.replace(archive)
    return hashlib.sha256(archive.read_bytes()).hexdigest()


# Kenney 单包免费端点要求先访问同站包页取得会话。
def fetch_kenney(opener, markup, pack, directory):
    identifier = re.search(r'data-download-id=[\"\']([^\"\']+)', markup)
    if not identifier:
        raise ValueError('官方包页缺少免费源包下载标识')
    endpoint = 'https://kenney.nl/download-link/' + identifier.group(1)
    download = json.loads(request(opener, endpoint, referer=pack['source_url']))['url']
    archive = directory / 'source.zip'
    digest = download_archive(opener, download, archive, pack['source_url'])
    extract_archive(archive, directory / 'extracted')
    version_match = re.search(r'<td[^>]*>Version</td>\s*<td[^>]*>(.*?)</td>', markup, re.S | re.I)
    pack.update(archive_sha256=digest, archive_path=str(archive.relative_to(ROOT)), download_url=endpoint, version=re.sub('<[^>]+>', '', version_match.group(1)).strip() if version_match else None)


# itch 的免费入口只授予免费上传文件，EXTRA、SOURCE 和付费系列不会取得权限。
def fetch_kaykit(opener, markup, pack, directory):
    purchase_markup = request(opener, pack['source_url'] + '/purchase').decode()
    price_match = re.search(r'"actual_price"\s*:\s*(\d+)', purchase_markup)
    if price_match and int(price_match.group(1)) > 0:
        pack.update(status='excluded-paid', error='官方包没有零价格下载入口')
        return
    csrf = re.search(r'name="csrf_token" value="([^"]+)', markup).group(1)
    endpoint = pack['source_url'] + '/download_url'
    download_page_url = json.loads(request(opener, endpoint, data={'csrf_token': csrf}, referer=pack['source_url'])).get('url')
    if not download_page_url:
        raise ValueError('官方免费入口未返回下载页')
    download_markup = request(opener, download_page_url).decode()
    csrf = re.search(r'name="csrf_token" value="([^"]+)', download_markup).group(1)
    uploads = itch_uploads(download_markup)
    if not uploads:
        raise ValueError('官方免费会话中没有可下载文件')
    records = []
    for upload in uploads:
        download = json.loads(request(opener, pack['source_url'] + '/file/' + upload['id'], data={'csrf_token': csrf}, referer=download_page_url))
        if not download.get('url'):
            raise ValueError('官方上传文件未返回下载地址：' + str(download.get('errors', [])))
        archive = directory / ('source-' + upload['id'] + '.zip')
        digest = download_archive(opener, download['url'], archive, download_page_url)
        destination = directory / 'extracted'
        if len(uploads) > 1:
            destination /= upload['id']
        extract_archive(archive, destination)
        records.append(dict(upload, archive_path=str(archive.relative_to(ROOT)), archive_sha256=digest))
    pack.update(uploads=records, archive_sha256=records[0]['archive_sha256'] if len(records) == 1 else hashlib.sha256(''.join(item['archive_sha256'] for item in records).encode()).hexdigest(), archive_path=records[0]['archive_path'], download_url=endpoint, version='; '.join(item['name'] for item in records))


# 一个包失败只记录该包失败，其他来源仍继续下载。
def fetch_pack(provider, url, output):
    identifier = url.rstrip('/').split('/')[-1]
    directory = output / provider / identifier
    pack = {'provider': provider, 'id': identifier, 'name': identifier, 'source_url': url, 'license': 'CC0-1.0', 'directory': str((directory / 'extracted').relative_to(ROOT)), 'status': 'pending'}
    try:
        opener = session()
        markup = request(opener, url).decode()
        pack['name'] = page_title(markup)
        pack['source_page_sha256'] = hashlib.sha256(markup.encode()).hexdigest()
        if not any(marker in markup.lower() for marker in ['cc0', 'creativecommons.org/publicdomain/zero', 'creative-commons-zero-v10-universal']):
            raise ValueError('官方包页未明确声明 CC0，需人工核对许可')
        pack['license_evidence_url'] = url
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'source-page.html').write_text(markup)
        if provider == 'kenney':
            fetch_kenney(opener, markup, pack, directory)
        else:
            fetch_kaykit(opener, markup, pack, directory)
        if pack['status'] != 'excluded-paid':
            pack['content_revision'] = 'sha256:' + pack['archive_sha256']
            pack['model_formats'] = model_formats(directory / 'extracted')
            pack['license_files'] = [str(path.relative_to(ROOT)) for path in sorted((directory / 'extracted').rglob('*')) if path.is_file() and ('license' in path.name.lower() or 'licence' in path.name.lower())]
            pack['status'] = 'downloaded'
    except Exception as error:
        pack.update(status='failed', error=str(error))
    return pack


# 清单逐包落盘，转换流程可在下载尚未全部结束时处理已完成包。
def write_manifest(path, manifest):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.partial')
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


# 默认抓取全部目录，也可按来源或包标识恢复单包下载。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', choices=['kenney', 'kaykit', 'all'], default='all')
    parser.add_argument('--pack', action='append', default=[])
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--manifest', type=Path, default=DEFAULT_MANIFEST)
    args = parser.parse_args()
    previous = json.loads(args.manifest.read_text()) if args.manifest.exists() else {'packs': []}
    manifest = {'snapshot_at': datetime.now(timezone.utc).isoformat(), 'scope': 'official-current-free-3d-including-public-legacy', 'catalog_pages': {}, 'packs': previous['packs']}
    candidates = []
    for provider, discover in [('kenney', discover_kenney), ('kaykit', discover_kaykit)]:
        if args.provider not in ['all', provider]:
            continue
        urls, pages = discover()
        manifest['catalog_pages'][provider] = pages
        candidates.extend((provider, url) for url in urls if not args.pack or url.split('/')[-1] in args.pack)
    write_manifest(args.manifest, manifest)
    # 先取得角色包，后续角色适配不必等待全部静态场景下载。
    candidates.sort(key=lambda item: (0 if item[0] == 'kaykit' and any(part in item[1] for part in ['adventurers', 'skeleton', 'character-animations']) else 1, item[0], item[1]))
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(fetch_pack, provider, url, args.output): (provider, url) for provider, url in candidates}
        for future in as_completed(futures):
            pack = future.result()
            manifest['packs'] = sorted([item for item in manifest['packs'] if (item['provider'], item['id']) != (pack['provider'], pack['id'])] + [pack], key=lambda item: (item['provider'], item['id']))
            write_manifest(args.manifest, manifest)
            print(pack['provider'], pack['id'], pack['status'], pack.get('model_formats', pack.get('error', '')), flush=True)
    counts = Counter(pack['status'] for pack in manifest['packs'])
    print(json.dumps({'total': len(manifest['packs']), 'statuses': counts}, ensure_ascii=False))
    return int(bool(counts.get('failed')))


if __name__ == '__main__':
    raise SystemExit(main())
