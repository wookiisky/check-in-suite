"""预览调度测试使用的独立 Blender 替身，不参与正式素材制作。"""

import json
from pathlib import Path
import sys

from PIL import Image


# 替身保留真实子进程与图片文件边界，便于检查缓存和部分失败恢复。
def main():
    if '--version' in sys.argv:
        print('Blender preview-test 1.0')
        return 0
    request = json.loads(Path(sys.argv[sys.argv.index('--jobs') + 1]).read_text())
    result = {'items': []}
    for job in request['jobs']:
        directory = Path(job['output_directory'])
        directory.mkdir(parents=True, exist_ok=True)
        count = directory.parent / 'render-count.txt'
        count.write_text(str(int(count.read_text()) + 1 if count.exists() else 1))
        if b'FAIL' in Path(job['model']).read_bytes():
            result['items'].append({'key': job['key'], 'status': 'failed', 'error': 'fixture-render-failed'})
            continue
        files = []
        for view in request['settings']['views']:
            path = directory / (view + '.png')
            Image.new('RGBA', (request['settings']['size'],) * 2, '#58a68b').save(path)
            files.append(str(path))
        result['items'].append({'key': job['key'], 'status': 'rendered', 'files': files, 'bounds_m': [[0, 1], [0, 2], [0, 3]]})
    Path(request['result_path']).write_text(json.dumps(result))
    return int(any(item['status'] == 'failed' for item in result['items']))


if __name__ == '__main__':
    raise SystemExit(main())
