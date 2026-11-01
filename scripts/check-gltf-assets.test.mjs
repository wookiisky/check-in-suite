import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkGltfAssets } from './check-gltf-assets.mjs';
import { triangleGLB } from './gltf-check-fixtures.mjs';

const command = fileURLToPath(new URL('./check-gltf-assets.mjs', import.meta.url));

// 每例使用独立资源目录，验证过程不能触碰正式模型。
async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'island-gltf-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('真实三角形通过 Khronos 校验，重复输入只检查一次且字节不变', async (t) => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'triangle.glb');
  const bytes = triangleGLB();
  await writeFile(filename, bytes);
  const report = await checkGltfAssets([directory, filename]);
  assert.equal(report.summary.files, 1);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.files[0].validation.info.totalVertexCount, 3);
  assert.deepEqual(await readFile(filename), bytes);
});

test('递归检查混合目录，格式错误和读取失败不会中断其余模型', async (t) => {
  const directory = await workspace(t);
  await mkdir(path.join(directory, 'nested'));
  await writeFile(path.join(directory, 'valid.glb'), triangleGLB());
  await writeFile(path.join(directory, 'nested', 'invalid.GLB'), Buffer.from('not a glb'));
  await writeFile(path.join(directory, 'ignored.txt'), 'ignored');
  const report = await checkGltfAssets([directory, path.join(directory, 'missing.glb')]);
  assert.equal(report.summary.files, 3);
  assert.equal(report.summary.failed, 2);
  assert.ok(report.summary.errors >= 2);
  assert.equal(report.files.filter((entry) => entry.validation?.issues.numErrors === 0).length, 1);
});

test('实际序列化的不兼容 glTF 版本被报告为错误', async (t) => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'version.glb');
  await writeFile(filename, triangleGLB({ version: '1.0' }));
  const report = await checkGltfAssets([filename]);
  assert.ok(report.summary.errors > 0);
  assert.equal(report.summary.failed, 1);
});

test('未知次版本保留为警告，不把警告当成失败', async (t) => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'warning.glb');
  await writeFile(filename, triangleGLB({ version: '2.1' }));
  const result = spawnSync(process.execPath, [command, filename], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.errors, 0);
  assert.ok(report.summary.warnings > 0);
});

test('外链图片被拒绝，检查不需要网络下载或读取模型目录之外的资源', async (t) => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'external.glb');
  await writeFile(filename, triangleGLB({ imageURI: 'https://example.invalid/texture.png' }));
  const report = await checkGltfAssets([filename]);
  assert.ok(report.summary.errors > 0);
  assert.ok(report.files[0].validation.issues.messages.some((issue) => issue.code === 'IO_ERROR'));
});

test('CLI 输出可解析报告，错误返回非零并可显式保存报告', async (t) => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'bad.glb');
  const output = path.join(directory, 'report.json');
  await writeFile(filename, Buffer.from('broken'));
  const result = spawnSync(process.execPath, [command, filename, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const stdout = JSON.parse(result.stdout);
  assert.ok(stdout.summary.errors > 0);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), stdout);
});

test('CLI 拒绝用报告覆盖输入，空目录也返回失败', async (t) => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'valid.glb');
  const bytes = triangleGLB();
  await writeFile(filename, bytes);
  const overwrite = spawnSync(process.execPath, [command, filename, '--output', filename], { encoding: 'utf8' });
  assert.equal(overwrite.status, 1);
  assert.deepEqual(await readFile(filename), bytes);
  const empty = path.join(directory, 'empty');
  await mkdir(empty);
  const noFiles = spawnSync(process.execPath, [command, empty], { encoding: 'utf8' });
  assert.equal(noFiles.status, 1);
});
