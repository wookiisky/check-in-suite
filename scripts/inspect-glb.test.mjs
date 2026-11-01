import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectGLB } from './inspect-glb.mjs';

// 使用真实 GLB 二进制结构，避免只测试已解码对象。
function serializeGLB(document, binary = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(document));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const chunks = [{ type: 0x4e4f534a, data: padded }];
  if (binary.length) chunks.push({ type: 0x004e4942, data: binary });
  const result = Buffer.alloc(12 + chunks.reduce((size, chunk) => size + 8 + chunk.data.length, 0));
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  let offset = 12;
  for (const chunk of chunks) {
    result.writeUInt32LE(chunk.data.length, offset);
    result.writeUInt32LE(chunk.type, offset + 4);
    chunk.data.copy(result, offset + 8);
    offset += 8 + chunk.data.length;
  }
  return result;
}

// 时间数据故意省略 accessor.max，验证工具确实读取 BIN。
function animatedFixture() {
  const binary = Buffer.alloc(12);
  [0, 0.5, 1.5].forEach((time, index) => binary.writeFloatLE(time, index * 4));
  return serializeGLB({
    asset: { version: '2.0', generator: 'fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'Rig', children: [1, 3], translation: [0, 1, 0] },
      { name: 'Hips', children: [2] },
      { name: 'Foot' },
      { name: 'Body', mesh: 0, skin: 0 },
    ],
    meshes: [{ name: 'BodyGeometry', primitives: [{ attributes: { POSITION: 0 } }] }],
    skins: [{ name: 'BodyRig', skeleton: 1, joints: [1, 2] }],
    accessors: [
      { componentType: 5126, type: 'VEC3', count: 3, min: [-1, 0, -1], max: [1, 2, 1] },
      { componentType: 5126, type: 'SCALAR', count: 3, bufferView: 0 },
    ],
    buffers: [{ byteLength: 12 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
    animations: [{
      name: 'Walk', samplers: [{ input: 1, output: 0 }],
      channels: [
        { sampler: 0, target: { node: 1, path: 'translation' } },
        { sampler: 0, target: { node: 2, path: 'rotation' } },
      ],
    }],
    images: [{ uri: 'body.png' }, { bufferView: 0, mimeType: 'image/png' }],
  }, binary);
}

test('汇总实际 JSON 和 BIN 中的节点、骨架、范围、动作及图片引用', () => {
  const result = inspectGLB(animatedFixture());
  assert.deepEqual(result.asset, { version: '2.0', generator: 'fixture' });
  assert.equal(result.nodes[3].mesh, 0);
  assert.equal(result.nodes[3].skin, 0);
  assert.equal(result.nodes[3].parent, 0);
  assert.deepEqual(result.roots, [{ node: 0, name: 'Rig', translation: [0, 1, 0] }]);
  assert.deepEqual(result.skins[0], {
    name: 'BodyRig', skeleton: 1,
    joints: [{ node: 1, name: 'Hips', parent: 0 }, { node: 2, name: 'Foot', parent: 1 }],
  });
  assert.deepEqual(result.meshes[0], {
    name: 'BodyGeometry',
    positions: [{ accessor: 0, count: 3, min: [-1, 0, -1], max: [1, 2, 1] }],
  });
  assert.deepEqual(result.animations, [{
    name: 'Walk', duration: 1.5, properties: { translation: 1, rotation: 1 },
    targets: [{ node: 1, name: 'Hips', path: 'translation' }, { node: 2, name: 'Foot', path: 'rotation' }],
  }]);
  assert.deepEqual(result.externalImages, ['body.png']);
});

test('支持无 BIN 的静态模型和 matrix 根变换', () => {
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1];
  const result = inspectGLB(serializeGLB({ asset: { version: '2.0' }, nodes: [{ name: 'Root', matrix }] }));
  assert.deepEqual(result.roots, [{ node: 0, name: 'Root', matrix }]);
  assert.deepEqual(result.skins, []);
  assert.deepEqual(result.animations, []);
});

test('拒绝错误 magic、版本与声明长度', () => {
  for (const [offset, value, message] of [[0, 0, /GLB_MAGIC/], [4, 1, /GLB_VERSION/], [8, 12, /GLB_LENGTH/]]) {
    const buffer = animatedFixture();
    buffer.writeUInt32LE(value, offset);
    assert.throws(() => inspectGLB(buffer), message);
  }
});

test('拒绝截断的文件头、chunk 头和 chunk 内容', () => {
  assert.throws(() => inspectGLB(Buffer.alloc(8)), /GLB_HEADER/);
  const incompleteHeader = Buffer.alloc(16);
  incompleteHeader.writeUInt32LE(0x46546c67, 0);
  incompleteHeader.writeUInt32LE(2, 4);
  incompleteHeader.writeUInt32LE(16, 8);
  assert.throws(() => inspectGLB(incompleteHeader), /GLB_CHUNK/);
  const incompleteChunk = animatedFixture();
  incompleteChunk.writeUInt32LE(incompleteChunk.length, 12);
  assert.throws(() => inspectGLB(incompleteChunk), /GLB_CHUNK/);
  assert.throws(() => inspectGLB(animatedFixture().subarray(0, -4)), /GLB_LENGTH/);
});

test('拒绝缺少 JSON、JSON 不在首个 chunk 和损坏的 JSON', () => {
  const noJSON = serializeGLB({});
  noJSON.writeUInt32LE(0x004e4942, 16);
  assert.throws(() => inspectGLB(noJSON), /GLB_JSON/);
  const badJSON = serializeGLB({});
  badJSON[20] = 0x21;
  assert.throws(() => inspectGLB(badJSON), /SyntaxError/);
});

test('CLI 可从实际文件输出 JSON，失败时退出非零', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inspect-glb-'));
  try {
    const file = path.join(directory, 'fixture.glb');
    await writeFile(file, animatedFixture());
    const output = execFileSync(process.execPath, ['scripts/inspect-glb.mjs', file], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).animations[0].duration, 1.5);
    await writeFile(file, Buffer.alloc(8));
    assert.throws(() => execFileSync(process.execPath, ['scripts/inspect-glb.mjs', file], { stdio: 'pipe' }), { status: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
