import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// markdownFiles finds documentation without following unrelated directories or symlinks.
async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.map(async (entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(name) : entry.isFile() && name.endsWith('.md') ? [name] : [];
  }));
  return files.flat().sort();
}

// prose removes front matter and fenced examples before interpreting Markdown structure.
function prose(text) {
  let fence;
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').split(/\r?\n/).filter((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && marker) { fence = marker[1]; return false; }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.slice(marker[0].length).trim() === '') fence = undefined;
      return false;
    }
    return true;
  }).join('\n');
}

// links supports inline links and reference definitions used by these documents.
function links(text) {
  const body = prose(text).replace(/`+[^`]*`+/g, '');
  const references = new Map([...body.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)/gm)].map((match) => [match[1].toLowerCase(), match[2]]));
  const targets = [...body.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g)].map((match) => match[1]);
  for (const match of body.matchAll(/!?\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const target = references.get((match[2] || match[1]).toLowerCase());
    if (target) targets.push(target);
  }
  return targets.map((target) => target.replace(/^<|>$/g, ''));
}

// headings follows GitHub-style Unicode anchors, including duplicate heading suffixes.
function headings(text) {
  const anchors = new Set();
  for (const match of prose(text).matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    let anchor = base;
    for (let number = 1; anchors.has(anchor); number++) anchor = `${base}-${number}`;
    anchors.add(anchor);
  }
  return anchors;
}

// metadata accepts only single-line summaries, block string lists and empty lists.
function metadata(text, file, errors) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) { errors.push(`META_FORMAT: ${file} 缺少专题元数据。`); return {}; }
  const values = {};
  let key;
  for (const line of block[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const field = line.match(/^([a-z]+):\s*(.*)$/);
    if (field) {
      key = field[1];
      if (Object.hasOwn(values, key)) errors.push(`META_FORMAT: ${file} 重复字段 ${key}。`);
      values[key] = field[2] === '[]' || !field[2] ? [] : field[2];
    } else if (/^\s*-\s+\S/.test(line) && Array.isArray(values[key])) {
      values[key].push(line.replace(/^\s*-\s+/, '').trim());
    } else errors.push(`META_FORMAT: ${file} 不支持的元数据写法：${line}`);
  }
  if (Object.keys(values).sort().join(',') !== 'owns,source,summary,tests') errors.push(`META_FIELDS: ${file} 只允许 summary、owns、source、tests 四个字段。`);
  if (typeof values.summary !== 'string' || /^(?:[\[{|>]|null$|true$|false$|\d+$)/i.test(values.summary)) errors.push(`META_SUMMARY: ${file} summary 必须是一行文字。`);
  for (const name of ['owns', 'source', 'tests']) {
    if (!Array.isArray(values[name])) errors.push(`META_LIST: ${file} ${name} 必须使用逐行列表或 []。`);
  }
  if (!Array.isArray(values.owns) || !values.owns.length) errors.push(`META_OWNS: ${file} owns 至少声明一个事实族。`);
  return values;
}

// localTarget resolves a local Markdown destination relative to its containing file.
function localTarget(destination, file, root) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) return null;
  const [target, ...fragment] = destination.split('#');
  const decoded = decodeURIComponent(target.split('?')[0]);
  return {
    file: !decoded ? file : decoded.startsWith('/') ? path.resolve(root, `.${decoded}`) : path.resolve(path.dirname(file), decoded),
    anchor: decodeURIComponent(fragment.join('#')),
  };
}

// checkSpec reports independent structure and reference errors in one pass.
export async function checkSpec(root = process.cwd()) {
  root = path.resolve(root);
  const errors = [];
  const index = path.join(root, 'spec/00_INDEX.md');
  const files = await markdownFiles(path.join(root, 'spec'));
  for (const name of ['README.md', 'AGENTS.md']) {
    if (await stat(path.join(root, name)).catch(() => null)) files.push(path.join(root, name));
  }
  const documents = new Map(await Promise.all(files.map(async (file) => [file, await readFile(file, 'utf8')])));
  if (!documents.has(index)) errors.push('ROOT_INDEX: 缺少 spec/00_INDEX.md。');
  const navigation = new Set();
  for (const target of links(documents.get(index) ?? '')) {
    try { const local = localTarget(target, index, root); if (local) navigation.add(local.file); } catch { /* The link check below reports malformed paths. */ }
  }
  const owners = new Map();
  const names = new Map();
  for (const [file, text] of documents) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative.startsWith('spec/') && file !== index && !relative.startsWith('spec/assets/')) {
      if (!/^spec\/[A-Z][A-Z0-9_]*\/[A-Za-z][A-Za-z0-9_]*\.md$/.test(relative)) errors.push(`TOPIC_PATH: ${relative} 应放在 spec/领域/专题.md。`);
      const name = path.basename(file).toLowerCase();
      if (names.has(name)) errors.push(`DUPLICATE_NAME: ${relative} 与 ${names.get(name)} 文件名重复。`);
      names.set(name, relative);
      if (!navigation.has(file)) errors.push(`NAVIGATION: ${relative} 未在根索引中直接链接。`);
      if ([...prose(text).matchAll(/^ {0,3}#\s+\S/gm)].length !== 1) errors.push(`TITLE_COUNT: ${relative} 必须只有一个一级标题。`);
      const values = metadata(text, relative, errors);
      for (const owner of Array.isArray(values.owns) ? values.owns : []) {
        if (owners.has(owner)) errors.push(`DUPLICATE_OWNER: ${relative} 与 ${owners.get(owner)} 重复拥有 ${owner}。`);
        owners.set(owner, relative);
      }
      for (const field of ['source', 'tests']) {
        for (const entry of Array.isArray(values[field]) ? values[field] : []) {
          const target = path.resolve(root, entry);
          if (path.isAbsolute(entry) || !target.startsWith(`${root}${path.sep}`) || !await stat(target).catch(() => null)) errors.push(`SOURCE_PATH: ${relative} ${field} 路径无效：${entry}`);
        }
      }
    }
    for (const destination of links(text)) {
      let target;
      try { target = localTarget(destination, file, root); } catch { errors.push(`LINK_PATH: ${relative} 链接编码无效：${destination}`); continue; }
      if (!target) continue;
      const info = await stat(target.file).catch(() => null);
      if (!info) { errors.push(`LINK_PATH: ${relative} 链接不存在：${destination}`); continue; }
      if (target.anchor && info.isFile() && target.file.endsWith('.md')) {
        const content = documents.get(target.file) ?? await readFile(target.file, 'utf8');
        if (!headings(content).has(target.anchor)) errors.push(`LINK_ANCHOR: ${relative} 标题不存在：${destination}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const errors = await checkSpec();
  if (errors.length) {
    console.error(`Spec 检查发现 ${errors.length} 个问题：\n${errors.join('\n')}`);
    process.exitCode = 1;
  } else console.log('Spec 结构与引用检查通过。');
}
