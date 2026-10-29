import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkSpec } from './check-spec.mjs';

// fixture keeps validation cases isolated from the repository being migrated.
async function fixture(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'island-spec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

const topic = `---
summary: 打卡规则与验证边界。
owns:
- checkin.behavior
source:
- implementation.mjs
tests: []
---
# 打卡

## 中文与 \`API\`

## 中文与 \`API\`
`;

test('valid metadata and Markdown links accept Chinese and repeated heading anchors', async (t) => {
  const root = await fixture(t, {
    'spec/00_INDEX.md': '# 入口\n\n[打卡](FEATURES/CHECKIN.md#中文与-api-1)\n',
    'spec/FEATURES/CHECKIN.md': topic,
    'implementation.mjs': 'export const value = 1;\n',
    'README.md': '# 项目\n[入口](spec/00_INDEX.md)\n[源码目录](spec/FEATURES/)\n[外链](https://example.com/path#heading)\n[邮件](mailto:example@example.com)\n\n```md\n[示例](missing.md)\n```\n\n`[代码](missing.md)`\n',
  });
  assert.deepEqual(await checkSpec(root), []);
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./check-spec.mjs', import.meta.url))], { cwd: root, encoding: 'utf8' });
  assert.match(output, /通过/);
});

test('one pass reports metadata, ownership, navigation, heading and link failures', async (t) => {
  const root = await fixture(t, {
    'spec/00_INDEX.md': '# 入口\n[打卡](FEATURES/CHECKIN.md#不存在)\n[缺失](missing.md)\n',
    'spec/FEATURES/CHECKIN.md': topic.replace('tests: []', 'tests: wrong\nextra: value') + '\n# 第二个标题\n',
    'spec/SYSTEM/checkin.md': topic,
  });
  const errors = await checkSpec(root);
  for (const code of ['META_FIELDS', 'META_LIST', 'SOURCE_PATH', 'DUPLICATE_OWNER', 'DUPLICATE_NAME', 'TITLE_COUNT', 'NAVIGATION', 'LINK_PATH', 'LINK_ANCHOR']) {
    assert.ok(errors.some((error) => error.startsWith(`${code}:`)), `${code}: ${errors.join('\n')}`);
  }
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./check-spec.mjs', import.meta.url))], { cwd: root, stdio: 'pipe' }), { status: 1 });
});

test('missing root and malformed metadata are reported without aborting other files', async (t) => {
  const root = await fixture(t, {
    'spec/FEATURES/BROKEN.md': '# 未填写元数据\n',
    'spec/FEATURES/EMPTY.md': '---\nsummary: []\nowns: []\nsource: []\ntests: []\n---\n# 空\n',
  });
  const errors = await checkSpec(root);
  for (const code of ['ROOT_INDEX', 'META_FORMAT', 'META_SUMMARY', 'META_OWNS']) {
    assert.ok(errors.some((error) => error.startsWith(`${code}:`)), errors.join('\n'));
  }
});

test('relative reference links and angle-bracket paths are checked', async (t) => {
  const root = await fixture(t, {
    'spec/00_INDEX.md': '# 入口\n[打卡][topic]\n\n[topic]: FEATURES/CHECKIN.md\n',
    'spec/FEATURES/CHECKIN.md': topic + '\n[图片](<../assets/example image.svg>)\n[当前](#打卡)\n',
    'spec/assets/example image.svg': '<svg/>',
    'implementation.mjs': '',
  });
  assert.deepEqual(await checkSpec(root), []);
});
