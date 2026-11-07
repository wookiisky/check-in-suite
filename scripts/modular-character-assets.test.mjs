import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { inspectGLB } from './inspect-glb.mjs';

const root = new URL('../', import.meta.url);
const readJSON = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const slots = ['face', 'head', 'upper', 'lower', 'shoes', 'back'];

// 当前鞋型均封闭脚掌，底层皮肤或脚骨不能穿出鞋面，空鞋仍显示基础脚部。
test('封闭鞋型覆盖基础脚掌，空鞋不覆盖身体', async () => {
  const catalog = await readJSON('internal/character/character-catalog.json');
  for (const item of catalog.wearables.filter((item) => item.slot === 'shoes')) {
    assert.deepEqual(item.covers, item.empty ? [] : ['feet'], item.wearable_key);
  }
});

// 同一头骨在目录和报价中都只出现一次。
test('同款绿眼骷髅只提供一件形象', async () => {
  const catalog = await readJSON('internal/character/character-catalog.json');
  const original = 'face-kaykit-legacy-skeleton-mage';
  const shared = 'face-kaykit-legacy-skeleton-minion';
  assert.ok(catalog.wearables.some((item) => item.wearable_key === shared));
  assert.ok(!catalog.wearables.some((item) => item.wearable_key === original));
  const offers = await readJSON('internal/shop/wearable-products.json');
  assert.deepEqual(offers.filter((item) => item.wearable_key.startsWith('face-')).map((item) => item.wearable_key),
    [shared, 'face-kaykit-skeletons-mage']);
});

// 四个旧版原包具有同一完整头骨，不能因叠加通用头皮而产生不同面容。
test('相同旧版源头骨复用完整面容', async () => {
  const manifest = await readJSON('internal/assets/provider-character-manifest.json');
  const identities = ['minion', 'archer', 'mage', 'warrior'].map((name) => {
    let key = `face-kaykit-legacy-skeleton-${name}`;
    const visited = new Set();
    while (manifest.aliases[key] && !visited.has(key)) {
      visited.add(key);
      key = manifest.aliases[key];
    }
    return key;
  });
  assert.equal(new Set(identities).size, 1, '完整源头骨必须使用同一几何和着色');
});

// 实际交付目录只有基础身体，职业部件与脸分别取得独立穿戴身份。
test('基础身体与六槽商品分离，Kenney人物不进入当前交付', async () => {
  const catalog = await readJSON('internal/character/character-catalog.json');
  assert.deepEqual(catalog.characters.map((item) => item.character_key).sort(), ['kaykit-medium-v1', 'kaykit-skeleton-v1']);
  const assets = await readJSON('internal/assets/builtin/catalog.json');
  assert.ok(!assets.some((item) => item.provider === 'kenney' && ['character', 'wearable'].includes(item.kind)));
  for (const body of catalog.characters) {
    assert.deepEqual(Object.keys(body.defaults).sort(), [...slots].sort());
    assert.ok(!body.fixed_nodes.includes('body_head'));
    for (const slot of slots) assert.equal(catalog.wearables.find((item) => item.wearable_key === body.defaults[slot])?.slot, slot);
  }
});

// 每件真实服装都有可加载蒙皮，脸、空头部和背部不依赖原角色订单。
test('六槽产物引用真实网格，形象与头部能够分别显示', async () => {
  const catalog = await readJSON('internal/character/character-catalog.json');
  const parsed = new Map();
  for (const item of [...catalog.characters, ...catalog.wearables]) {
    if (!parsed.has(item.model_asset_key)) parsed.set(item.model_asset_key, inspectGLB(await readFile(new URL(`internal/assets/builtin/${item.model_asset_key}.glb`, root))));
    const model = parsed.get(item.model_asset_key);
    assert.deepEqual(model.externalImages, [], item.model_asset_key);
    const nodes = new Map(model.nodes.map((node) => [node.name, node]));
    if (item.wearable_key) {
      assert.ok(slots.includes(item.slot));
      assert.ok(item.nodes.length || item.empty, item.wearable_key);
      for (const name of item.nodes) {
        assert.ok(nodes.get(name)?.mesh !== undefined, `${item.wearable_key}/${name}`);
        assert.ok(nodes.get(name)?.skin !== undefined, `${item.wearable_key}/${name}: 未蒙皮`);
      }
      if (item.slot === 'face') {
        assert.ok(item.nodes.includes('face_scalp'), item.wearable_key);
        assert.ok(item.covers.includes('head') && item.covers.includes('scalp'));
      }
    }
  }
  const arrow = catalog.wearables.find((item) => item.wearable_key === 'head-arrow-v1');
  assert.equal(arrow?.slot, 'head');
  assert.deepEqual(arrow.covers, []);
  assert.ok(catalog.wearables.some((item) => item.slot === 'back' && !item.empty));
});

// 加工证据绑定真实产物和解剖分离结果，禁止把骨骼当作衣服出售。
test('骷髅身体保留真实骨骼，独立衣物已剥离来源身体', async () => {
  const manifest = await readJSON('internal/assets/provider-character-manifest.json');
  const configuration = await readJSON('scripts/modular-character-sources.json');
  assert.equal(manifest.recipe, configuration.recipe);
  // 加工标记只证明产物生成；候选的分类验收由独立检查记录负责。
  assert.equal(manifest.processing_complete ?? manifest.complete, true);
  assert.ok(manifest.skeleton_body?.source_bone_faces > 0);
  assert.ok(manifest.skeleton_body?.completed_regions?.includes('pelvis'));
  assert.ok(manifest.wearable_evidence.length > 10);
  for (const item of manifest.wearable_evidence) {
    if (!['upper', 'lower', 'shoes'].includes(item.slot)) continue;
    assert.equal(item.remaining_body_faces, 0, item.wearable_key);
  }
});

// 腰带和护腕必须发布原生网格，不再以备用裤装替代或整类排除。
test('旧版骷髅的完整原生护腕和腰带进入穿戴目录', async () => {
  const catalog = await readJSON('internal/character/character-catalog.json');
  const manifest = await readJSON('internal/assets/provider-character-manifest.json');
  for (const source of ['minion', 'archer', 'mage', 'warrior']) {
    const key = `kaykit-legacy-skeleton-${source}-upper`;
    assert.ok(catalog.wearables.some((entry) => entry.wearable_key === key && entry.nodes.length), key);
    assert.equal(manifest.wearable_evidence.find((entry) => entry.wearable_key === key)?.native, true, key);
  }
  const belt = 'kaykit-legacy-skeleton-minion-lower';
  assert.ok(catalog.wearables.some((entry) => entry.wearable_key === belt && entry.nodes.length), belt);
  assert.equal(manifest.wearable_evidence.find((entry) => entry.wearable_key === belt)?.native, true, belt);
});

// 只有实际包住头顶的物件才遮盖头皮，胡须和围领必须保留所选脸的头顶。
test('胡须和围领不会隐藏任一脸型的头皮', async () => {
  const catalog = await readJSON('internal/character/character-catalog.json');
  for (const key of ['hair-barbarian-v1', 'kaykit-legacy-skeleton-mage-head']) {
    const item = catalog.wearables.find((entry) => entry.wearable_key === key);
    assert.ok(item, key);
    for (const face of catalog.wearables.filter((entry) => entry.slot === 'face')) {
      const hidden = new Set(Object.entries(face.regions ?? {}).filter(([region]) => item.covers.includes(region)).flatMap(([, names]) => names));
      assert.ok(!hidden.has('face_scalp'), `${key}/${face.wearable_key}: 头皮被错误隐藏`);
    }
  }
});

// 微笑脸的后脑与脸相接，头饰只能遮掉重复的眉毛。
test('带眉头饰遮盖微笑脸的眉毛并保留完整头部', async () => {
  const catalog = await readJSON('internal/character/character-catalog.json');
  const face = catalog.wearables.find((item) => item.wearable_key === 'face-kaykit-adventurers-ranger');
  const hair = catalog.wearables.find((item) => item.wearable_key === 'hair-rogue-v1');
  const hidden = Object.entries(face.regions).filter(([region]) => hair.covers.includes(region)).flatMap(([, names]) => names);
  assert.deepEqual(hidden, ['face_brows']);
  assert.ok(face.nodes.includes('face_scalp'));
});

// 从正式GLB的真实三角面检查鼻下前脸，不能以网格非空替代嘴和下颌完整性。
test('独立脸型保留嘴部和下颌的实际表面', async () => {
  const catalog = await readJSON('internal/character/character-catalog.json');
  const face = catalog.wearables.find((entry) => entry.wearable_key === 'face-kaykit-adventurers-ranger');
  const bytes = await readFile(new URL(`internal/assets/builtin/${face.model_asset_key}.glb`, root));
  const length = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + length).toString());
  const binary = bytes.subarray(28 + length);
  const scalars = (index, width) => {
    const accessor = document.accessors[index];
    const view = document.bufferViews[accessor.bufferView];
    const size = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType];
    const method = { 5121: 'readUInt8', 5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE' }[accessor.componentType];
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    return Array.from({ length: accessor.count }, (_, row) => Array.from({ length: width }, (_, column) => binary[method](start + row * (view.byteStride ?? width * size) + column * size)));
  };
  const triangles = [];
  for (const node of document.nodes.filter((entry) => face.nodes.includes(entry.name))) {
    for (const primitive of document.meshes[node.mesh].primitives) {
      const positions = scalars(primitive.attributes.POSITION, 3);
      const indices = primitive.indices === undefined ? positions.map((_, index) => index) : scalars(primitive.indices, 1).flat();
      for (let index = 0; index < indices.length; index += 3) triangles.push(indices.slice(index, index + 3).map((vertex) => positions[vertex]));
    }
  }
  for (const [x, y] of [[0, 1.33], [-0.05, 1.4], [0.05, 1.4]]) {
    const hits = triangles.flatMap(([a, b, c]) => {
      const determinant = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(determinant) < 1e-10) return [];
      const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / determinant;
      const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / determinant;
      if (u < -1e-5 || v < -1e-5 || u + v > 1 + 1e-5) return [];
      return [u * a[2] + v * b[2] + (1 - u - v) * c[2]];
    });
    assert.ok(hits.some((depth) => depth > 0) && hits.some((depth) => depth < 0),
      `下颌未形成完整头部: x=${x}, y=${y}, depths=${hits}`);
  }
});
