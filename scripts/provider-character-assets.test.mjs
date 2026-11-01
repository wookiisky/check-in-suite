import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { inspectGLB } from './inspect-glb.mjs';

const root = new URL('../', import.meta.url);

// 读取实际交付容器，按资源身份复用解析结果，不依赖原始加工工程。
async function modelReader() {
  const cache = new Map();
  return async (assetKey) => {
    if (!cache.has(assetKey)) {
      const bytes = await readFile(new URL(`internal/assets/builtin/${assetKey}.glb`, root));
      const length = bytes.readUInt32LE(12);
      const document = JSON.parse(bytes.subarray(20, 20 + length).toString());
      cache.set(assetKey, { document, binary: bytes.subarray(28 + length), inspection: inspectGLB(bytes) });
    }
    return cache.get(assetKey);
  };
}

// 按真实访问器步长读取浮点数据，包括交错顶点布局。
function floats(model, index, width) {
  const accessor = model.document.accessors[index];
  assert.equal(accessor.componentType, 5126);
  const view = model.document.bufferViews[accessor.bufferView];
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, row) => Array.from({ length: width }, (_, column) => model.binary.readFloatLE(start + row * (view.byteStride ?? width * 4) + column * 4)));
}

// 绑定矩阵和父骨骼同时决定兼容性，骨骼同名不足以证明服装可复用。
function binding(model, skin) {
  const matrices = floats(model, skin.inverseBindMatrices, 16);
  return new Map(skin.joints.map((index, position) => [model.document.nodes[index].name, {
    parent: model.inspection.nodes[model.inspection.nodes[index].parent]?.name ?? null,
    matrix: matrices[position],
  }]));
}

// 从真实顶点计算身体分区范围，避免只验证定义中的比例标签。
function regionBounds(model, names) {
  const lower = [Infinity, Infinity, Infinity]; const upper = [-Infinity, -Infinity, -Infinity];
  for (const name of names) {
    const node = model.document.nodes.find((item) => item.name === name);
    assert.ok(node?.mesh !== undefined, `standard body region missing: ${name}`);
    for (const primitive of model.document.meshes[node.mesh].primitives) {
      for (const point of floats(model, primitive.attributes.POSITION, 3)) {
        point.forEach((value, axis) => { lower[axis] = Math.min(lower[axis], value); upper[axis] = Math.max(upper[axis], value); });
      }
    }
  }
  return [...lower, ...upper];
}

// 每个可选人物与每件衣服都必须满足同一标准，不能只抽查首个角色。
test('全部交付人物和四槽服装共用实际骨骼层级与逆绑定矩阵', async () => {
  const catalog = JSON.parse(await readFile(new URL('internal/character/character-catalog.json', root), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('internal/assets/provider-character-manifest.json', root), 'utf8'));
  const partitionedHeads = new Set(manifest.characters.filter((entry) => entry.scalp_partition).map((entry) => entry.definition.character_key));
  const base = catalog.characters.find((item) => item.character_key === 'kaykit-medium-v1');
  const readModel = await modelReader();
  const canonical = await readModel(base.model_asset_key);
  const expected = binding(canonical, canonical.document.skins[0]);
  const assets = new Set([...catalog.characters, ...catalog.wearables].map((item) => item.model_asset_key));
  for (const character of catalog.characters) {
    assert.equal(character.body_key, base.body_key, character.character_key);
    assert.equal(character.rig_key, base.rig_key, character.character_key);
    assert.equal(character.scale, base.scale, character.character_key);
    const model = await readModel(character.model_asset_key);
    for (const [region, names] of Object.entries(base.body_regions)) {
      if (region === 'scalp' && partitionedHeads.has(character.character_key)) continue;
      const standard = regionBounds(canonical, names);
      const actual = regionBounds(model, character.body_regions[region]);
      actual.forEach((value, axis) => assert.ok(Math.abs(value - standard[axis]) < 0.00001, `${character.character_key}/${region}: body proportion changed`));
    }
    if (partitionedHeads.has(character.character_key)) {
      // 头皮来自真实头壳分区，不能再用整球的六个边界值证明脸与头皮兼容。
      const standard = regionBounds(canonical, ['body_head', ...base.body_regions.scalp]);
      const actual = regionBounds(model, ['body_head', ...character.body_regions.scalp]);
      actual.forEach((value, axis) => assert.ok(axis < 3 ? value >= standard[axis] - 0.00001 : value <= standard[axis] + 0.00001,
        `${character.character_key}: head exceeds standard envelope`));
    }
    for (const [slot, key] of Object.entries(character.defaults)) {
      const wearable = catalog.wearables.find((item) => item.wearable_key === key);
      assert.ok(wearable, `${character.character_key}/${slot}: default missing`);
      assert.equal(wearable.slot, slot);
      assert.equal(wearable.body_key, base.body_key);
      assert.equal(wearable.rig_key, base.rig_key);
    }
  }
  for (const assetKey of assets) {
    const model = await readModel(assetKey);
    assert.deepEqual(model.inspection.externalImages, [], assetKey);
    assert.ok(model.document.skins?.length, assetKey);
    for (const skin of model.document.skins) {
      const actual = binding(model, skin);
      assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), assetKey);
      for (const [bone, original] of expected) {
        const next = actual.get(bone);
        assert.equal(next.parent, original.parent, `${assetKey}/${bone}`);
        next.matrix.forEach((value, index) => assert.ok(Math.abs(value - original.matrix[index]) < 0.00001, `${assetKey}/${bone}/bind[${index}]: ${value} != ${original.matrix[index]}`));
      }
    }
  }
});

// 检查所有部件的真实蒙皮和身体遮盖，空发型必须明确声明而非伪造网格。
test('全部服装是有归一化权重的独立部件，脸不包含在发型槽中', async () => {
  const catalog = JSON.parse(await readFile(new URL('internal/character/character-catalog.json', root), 'utf8'));
  const readModel = await modelReader();
  for (const wearable of catalog.wearables) {
    if (wearable.empty) {
      assert.equal(wearable.slot, 'hair');
      assert.deepEqual(wearable.nodes, []);
      assert.deepEqual(wearable.covers, []);
      continue;
    }
    assert.ok(wearable.nodes.length, wearable.wearable_key);
    const model = await readModel(wearable.model_asset_key);
    for (const name of wearable.nodes) {
      const node = model.document.nodes.find((item) => item.name === name);
      assert.ok(node && node.mesh !== undefined && node.skin !== undefined, `${wearable.wearable_key}/${name}: skinned mesh missing`);
      assert.notEqual(name, 'body_head', '换发型不能同时换掉固定脸');
      for (const primitive of model.document.meshes[node.mesh].primitives) {
        assert.ok(primitive.attributes.JOINTS_0 !== undefined);
        assert.ok(primitive.attributes.WEIGHTS_0 !== undefined);
        for (const weights of floats(model, primitive.attributes.WEIGHTS_0, 4)) {
          assert.ok(weights.every((value) => Number.isFinite(value) && value >= 0), wearable.wearable_key);
          assert.ok(Math.abs(weights.reduce((total, value) => total + value, 0) - 1) < 0.0001, wearable.wearable_key);
        }
      }
    }
  }
});
