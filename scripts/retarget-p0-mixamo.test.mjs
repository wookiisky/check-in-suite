import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Matrix4, Quaternion, Vector3 } from 'three';

// 检查真实交付 GLB 的局部绑定和采样，不能用描述文件代替动作数据。
function readGLB(path) {
  const bytes = readFileSync(path);
  const jsonLength = bytes.readUInt32LE(12);
  return { document: JSON.parse(bytes.subarray(20, 20 + jsonLength)), binary: bytes.subarray(28 + jsonLength) };
}

// 本次 Blender 导出使用紧密排列的 float32 动画访问器。
function values(model, accessorIndex) {
  const accessor = model.document.accessors[accessorIndex];
  const view = model.document.bufferViews[accessor.bufferView];
  assert.equal(accessor.componentType, 5126);
  const components = { SCALAR: 1, VEC3: 3, VEC4: 4 }[accessor.type];
  const result = [];
  for (let index = 0; index < accessor.count; index++) {
    const row = [];
    for (let component = 0; component < components; component++) row.push(model.binary.readFloatLE((view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * (view.byteStride ?? components * 4) + component * 4));
    result.push(row);
  }
  return result;
}

// 缺省变换与 glTF 的单位矩阵语义一致。
function localMatrix(node) {
  if (node.matrix) return new Matrix4().fromArray(node.matrix);
  return new Matrix4().compose(new Vector3().fromArray(node.translation ?? [0, 0, 0]), new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]), new Vector3().fromArray(node.scale ?? [1, 1, 1]));
}

const output = 'web/public/models/p0/animations/exercise.glb';
const original = 'web/public/models/p0/kaykit/rogue.glb';

test('转换结果只包含目标骨架与有限的 Exercise 采样，没有 Xbot 网格', () => {
  const model = readGLB(output);
  assert.equal(model.document.meshes?.length ?? 0, 0);
  assert.equal(model.document.animations.length, 1);
  const animation = model.document.animations[0];
  assert.equal(animation.name, 'Exercise');
  const duration = Math.max(...animation.samplers.flatMap((sampler) => values(model, sampler.input).flat()));
  assert.ok(duration >= 0.5 && duration <= 5);
  assert.ok(animation.channels.length > 15);
  for (const sampler of animation.samplers) for (const sample of values(model, sampler.output)) for (const value of sample) assert.ok(Number.isFinite(value));
  assert.ok(!model.document.nodes.some((node) => node.name?.startsWith('mixamorig')));
});

test('导出骨骼局部 rest 与原人物匹配，轨道无需浏览器重定向', () => {
  const model = readGLB(output);
  const source = readGLB(original);
  const joints = source.document.skins[0].joints.map((index) => source.document.nodes[index]);
  const parentName = (document, node) => document.nodes.find((parent) => parent.children?.includes(document.nodes.indexOf(node)))?.name;
  for (const joint of joints) {
    const converted = model.document.nodes.find((node) => node.name === joint.name);
    assert.ok(converted, `缺少骨骼 ${joint.name}`);
    assert.equal(parentName(model.document, converted), parentName(source.document, joint), `骨骼 ${joint.name} 的父子关系变化`);
    const expected = localMatrix(joint).elements;
    const actual = localMatrix(converted).elements;
    assert.ok(expected.every((value, index) => Math.abs(value - actual[index]) < 0.0001), `骨骼 ${joint.name} 的 rest 变换变化`);
  }
});

test('手脚旋转真实变化，root 与 hips 不携带水平位移', () => {
  const model = readGLB(output);
  const animation = model.document.animations[0];
  for (const name of ['upperarm.l', 'upperarm.r', 'foot.l', 'foot.r']) {
    const channel = animation.channels.find((channel) => model.document.nodes[channel.target.node].name === name && channel.target.path === 'rotation');
    assert.ok(channel, `缺少 ${name} 旋转`);
    const rotations = values(model, animation.samplers[channel.sampler].output);
    const initial = new Quaternion().fromArray(rotations[0]);
    assert.ok(rotations.some((sample) => initial.angleTo(new Quaternion().fromArray(sample)) > 0.02), `${name} 没有运动`);
  }
  for (const channel of animation.channels) {
    const name = model.document.nodes[channel.target.node].name;
    if (!['root', 'hips'].includes(name) || channel.target.path !== 'translation') continue;
    for (const sample of values(model, animation.samplers[channel.sampler].output)) {
      assert.ok(Math.abs(sample[0]) < 0.0001 && Math.abs(sample[2]) < 0.0001, `${name} 携带水平位移`);
    }
  }
});
