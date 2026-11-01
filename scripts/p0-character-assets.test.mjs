import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { inspectGLB } from './inspect-glb.mjs';

const directory = new URL('../web/public/models/p0/character/', import.meta.url);

// 直接检查交付二进制，防止描述文件声称有部件而实际只切换完整角色。
test('四槽均包含两个独立蒙皮部件，并共用同一套骨架', async () => {
  const definition = JSON.parse(await readFile(new URL('character.json', directory), 'utf8'));
  const binary = await readFile(new URL('modular.glb', directory));
  const model = inspectGLB(binary);
  assert.deepEqual(model.externalImages, [], '交付 GLB 应内嵌纹理，不能遗漏外链图片');
  const jsonLength = binary.readUInt32LE(12);
  const document = JSON.parse(binary.subarray(20, 20 + jsonLength).toString());
  const data = binary.subarray(28 + jsonLength);
  const names = new Map(model.nodes.map((node) => [node.name, node]));
  const used = new Set();
  assert.deepEqual(Object.keys(definition.slots).sort(), ['hair', 'lower', 'shoes', 'upper']);
  for (const options of Object.values(definition.slots)) {
    assert.equal(options.length, 2);
    const shapes = [];
    for (const option of options) {
      assert.ok(option.nodes.length);
      const geometry = [];
      for (const name of option.nodes) {
        assert.ok(!used.has(name), `部件不能复用另一个选项的同一网格: ${name}`);
        used.add(name);
        const node = names.get(name);
        assert.ok(node && node.mesh !== undefined && node.skin !== undefined, `必须是蒙皮网格: ${name}`);
        for (const primitive of document.meshes[node.mesh].primitives) {
          const accessor = document.accessors[primitive.attributes.POSITION];
          const view = document.bufferViews[accessor.bufferView];
          const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
          const digest = createHash('sha256');
          // 比较实际 POSITION 字节，不能把不同 accessor 索引误当成几何不同。
          for (let index = 0; index < accessor.count; index++) digest.update(data.subarray(offset + index * (view.byteStride ?? 12), offset + index * (view.byteStride ?? 12) + 12));
          geometry.push(digest.digest('hex'));
        }
        assert.deepEqual(model.skins[node.skin].joints, model.skins[0].joints);
      }
      shapes.push(JSON.stringify(geometry));
    }
    assert.notEqual(shapes[0], shapes[1], '两个选项需要不同的实际几何');
  }
  for (const name of [...definition.fixed_nodes, ...Object.values(definition.body_regions).flat()]) assert.ok(names.has(name));
  assert.ok(definition.scale > 0 && definition.scale < 1);
  for (const name of ['Idle', 'Walking_A', 'Running_A', 'Sit_Chair_Idle', 'Cheer']) assert.ok(model.animations.some((clip) => clip.name === name));
});

// 以真实采样验证原地动作，防止代码移动和动画根位移叠加。
test('交付动作不携带水平根位移，所有顶点保留归一化蒙皮权重', async () => {
  const buffer = await readFile(new URL('modular.glb', directory));
  const length = buffer.readUInt32LE(12);
  const document = JSON.parse(buffer.subarray(20, 20 + length).toString());
  const data = buffer.subarray(28 + length);
  for (const animation of document.animations) {
    for (const channel of animation.channels) {
      if (document.nodes[channel.target.node].name !== 'root' || channel.target.path !== 'translation') continue;
      const accessor = document.accessors[animation.samplers[channel.sampler].output];
      const view = document.bufferViews[accessor.bufferView];
      const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      for (let index = 0; index < accessor.count; index++) {
        const start = offset + index * (view.byteStride ?? 12);
        assert.ok(Math.abs(data.readFloatLE(start)) < 0.00001, animation.name);
        assert.ok(Math.abs(data.readFloatLE(start + 8)) < 0.00001, animation.name);
      }
    }
  }
  for (const mesh of document.meshes) {
    for (const primitive of mesh.primitives) {
      const accessor = document.accessors[primitive.attributes.WEIGHTS_0];
      assert.equal(accessor.componentType, 5126);
      const view = document.bufferViews[accessor.bufferView];
      const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      for (let index = 0; index < accessor.count; index++) {
        const start = offset + index * (view.byteStride ?? 16);
        const weights = Array.from({ length: 4 }, (_, joint) => data.readFloatLE(start + joint * 4));
        assert.ok(weights.every((weight) => weight >= 0));
        assert.ok(Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) < 0.0001, mesh.name);
      }
    }
  }
});

// 与入库的源 GLB 比较真实逆绑定矩阵，不能只用骨骼同名判断兼容。
test('加工前后保留相同骨骼层级与绑定姿势', async () => {
  const bindings = [];
  for (const file of [new URL('../web/public/models/p0/kaykit/rogue.glb', import.meta.url), new URL('modular.glb', directory)]) {
    const buffer = await readFile(file);
    const model = inspectGLB(buffer);
    const length = buffer.readUInt32LE(12);
    const document = JSON.parse(buffer.subarray(20, 20 + length).toString());
    const data = buffer.subarray(28 + length);
    const skin = document.skins[0];
    const accessor = document.accessors[skin.inverseBindMatrices];
    const view = document.bufferViews[accessor.bufferView];
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    bindings.push(new Map(skin.joints.map((node, index) => [document.nodes[node].name, {
      parent: model.nodes[model.nodes[node].parent]?.name ?? null,
      matrix: Array.from({ length: 16 }, (_, element) => data.readFloatLE(start + index * (view.byteStride ?? 64) + element * 4)),
    }])));
  }
  assert.deepEqual([...bindings[0].keys()].sort(), [...bindings[1].keys()].sort());
  for (const [name, original] of bindings[0]) {
    const processed = bindings[1].get(name);
    assert.equal(original.parent, processed.parent, name);
    for (let element = 0; element < 16; element++) assert.ok(Math.abs(original.matrix[element] - processed.matrix[element]) < 0.00001, name);
  }
});
