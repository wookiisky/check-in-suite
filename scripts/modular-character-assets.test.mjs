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

// 同一头骨在目录中只有一个可售身份。
test('同款绿眼骷髅只提供一件形象', async () => {
  const catalog = await readJSON('internal/character/character-catalog.json');
  const original = 'face-kaykit-legacy-skeleton-mage';
  const shared = 'face-kaykit-legacy-skeleton-minion';
  assert.ok(catalog.wearables.some((item) => item.wearable_key === shared));
  assert.ok(!catalog.wearables.some((item) => item.wearable_key === original));
  assert.deepEqual(catalog.wearables.filter((item) => item.slot === 'face' && item.sellable).map((item) => item.wearable_key),
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
  const shorts = manifest.wearable_evidence.find((item) => item.wearable_key === 'skeleton-minion-lower-v1');
  assert.ok(shorts?.removed_cap_faces > 0, '棕短裤应剥离腰口多余的灰色封面');
  for (const item of manifest.wearable_evidence) {
    if (!['upper', 'lower', 'shoes'].includes(item.slot)) continue;
    assert.equal(item.remaining_body_faces, 0, item.wearable_key);
  }
});

// 配方决定哪些部件出货，保留的原生部件应有真实网格。
test('穿戴目录遵守配方的槽位排除', async () => {
  const catalog = await readJSON('internal/character/character-catalog.json');
  const manifest = await readJSON('internal/assets/provider-character-manifest.json');
  const configuration = await readJSON('scripts/modular-character-sources.json');
  const published = new Set([...catalog.wearables, ...manifest.wearable_evidence].map((item) => item.wearable_key));
  for (const source of configuration.sources) {
    for (const slot of source.excluded_slots ?? []) {
      const key = `${source.key}-${slot}`;
      assert.ok(!published.has(key), key);
    }
  }
  for (const key of ['kaykit-legacy-skeleton-mage-upper', 'kaykit-legacy-skeleton-mage-lower', 'kaykit-legacy-skeleton-warrior-upper']) {
    assert.ok(catalog.wearables.some((entry) => entry.wearable_key === key && entry.nodes.length), key);
    assert.equal(manifest.wearable_evidence.find((entry) => entry.wearable_key === key)?.native, true, key);
  }
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

// 读取正式模型的网格与访问器数据，用于检查实际出货的三角面。
async function readWearableMesh(item) {
  const bytes = await readFile(new URL(`internal/assets/builtin/${item.model_asset_key}.glb`, root));
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
  const primitives = document.nodes.filter((node) => item.nodes.includes(node.name))
    .flatMap((node) => document.meshes[node.mesh].primitives);
  return { document, primitives, scalars };
}

// 圆领应在中线附近逐渐升高，左右肩带保留完整高度。
test('背心实际网格保留对称圆领和两侧肩带', async () => {
  const { wearables } = await readJSON('internal/character/character-catalog.json');
  const tank = wearables.find((item) => item.wearable_key === 'upper-human-tank-v1');
  const { primitives, scalars } = await readWearableMesh(tank);
  const positions = primitives.flatMap(({ attributes }) => scalars(attributes.POSITION, 3));
  const center = Math.max(...positions.filter(([x]) => Math.abs(x) < 0.005).map(([, height]) => height));
  for (const side of [-1, 1]) {
    const inner = Math.max(...positions.filter(([x]) => x * side > 0.03 && x * side < 0.07).map(([, height]) => height));
    const shoulder = Math.max(...positions.filter(([x]) => x * side > 0.16 && x * side < 0.22).map(([, height]) => height));
    assert.ok(inner > center && inner - center < 0.035, `领口在中线旁应平缓上升：${side}`);
    assert.ok(shoulder - center > 0.1, `领口与肩带应有明显高差：${side}`);
  }
  const weldedEdges = new Map();
  for (const primitive of primitives) {
    const vertices = scalars(primitive.attributes.POSITION, 3).map((position) => position.map((value) => Math.round(value * 1e6)).join(','));
    const indices = scalars(primitive.indices, 1).flat();
    for (let first = 0; first < indices.length; first += 3) {
      for (let corner = 0; corner < 3; corner += 1) {
        const edge = [vertices[indices[first + corner]], vertices[indices[first + (corner + 1) % 3]]].sort().join('|');
        weldedEdges.set(edge, (weldedEdges.get(edge) ?? 0) + 1);
      }
    }
  }
  assert.ok([...weldedEdges.values()].every((count) => count === 2), '圆领裁片和下摆封边必须焊成封闭布料');
});

// 验证出货 GLB 的底色，确保染色材质仅属于目标布料。
test('背心、披风和披肩以独立的无贴图材质提供预设换色', async () => {
  const { wearables } = await readJSON('internal/character/character-catalog.json');
  const palette = await readJSON('internal/character/wearable-colors.json');
  const defaults = new Map([
    ['upper-human-tank-v1', 'ivory'],
    ['kaykit-adventurers-knight-back-cape', 'red'],
    ['kaykit-skeletons-minion-back-cloak', 'brown'],
  ]);
  const toLinear = (channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  const backs = wearables.filter((item) => item.slot === 'back');
  assert.deepEqual([...new Set(backs.map((item) => item.wearable_key).filter((key) => /-back-(cape|cloak)$/.test(key)))].sort(),
    [...defaults.keys()].slice(1).sort());
  assert.deepEqual(wearables.filter((item) => item.dye_material === 'wearable_dye').map((item) => item.wearable_key).sort(), [...defaults.keys()].sort());
  for (const item of wearables.filter((item) => defaults.has(item.wearable_key))) {
    assert.equal(item.default_color_key, defaults.get(item.wearable_key));
    const color = palette.find((entry) => entry.key === item.default_color_key);
    const bytes = await readFile(new URL(`internal/assets/builtin/${item.model_asset_key}.glb`, root));
    const model = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
    const materialIndex = model.materials.findIndex((material) => material.name === item.dye_material);
    assert.notEqual(materialIndex, -1, item.wearable_key);
    const material = model.materials[materialIndex].pbrMetallicRoughness;
    assert.equal(material.baseColorTexture, undefined);
    for (const [index, channel] of color.hex.slice(1).match(/../g).entries()) {
      assert.ok(Math.abs(material.baseColorFactor[index] - toLinear(parseInt(channel, 16) / 255)) < 1e-6, item.wearable_key);
    }
    for (const node of model.nodes.filter((entry) => entry.mesh !== undefined)) {
      const isCloth = item.nodes.includes(node.name);
      for (const primitive of model.meshes[node.mesh].primitives) {
        assert.equal(primitive.material === materialIndex, isCloth, node.name);
        if (isCloth) assert.equal(primitive.attributes.COLOR_0, undefined, node.name);
      }
    }
  }
});

// 按正式 GLB 的三角面核对染色选区，防止配件或同模型的其他穿戴串色。
test('贴图换色只覆盖配方声明的网格和 UV 区域', async () => {
  const { wearables } = await readJSON('internal/character/character-catalog.json');
  const recipes = await readJSON('scripts/modular-character-dye-regions.json');
  const textured = wearables.filter((item) => item.pack_key !== 'local-hairstyles' && item.dye_material?.startsWith('dye_'));
  assert.deepEqual(textured.map((item) => item.wearable_key).sort(), Object.keys(recipes).sort());

  for (const item of textured) {
    const { nodes, default_color } = recipes[item.wearable_key];
    assert.equal(item.default_color_key, default_color, item.wearable_key);
    const { document, scalars } = await readWearableMesh(item);
    const materialIndex = document.materials.findIndex((material) => material.name === item.dye_material);
    assert.notEqual(materialIndex, -1, item.wearable_key);
    assert.ok(document.materials[materialIndex].pbrMetallicRoughness.baseColorTexture);
    const dyedNodes = new Set();
    for (const node of document.nodes.filter((entry) => entry.mesh !== undefined)) {
      for (const primitive of document.meshes[node.mesh].primitives) {
        const dyed = primitive.material === materialIndex;
        const region = nodes[node.name];
        if (!region) {
          assert.equal(dyed, false, node.name);
          continue;
        }
        if (dyed) dyedNodes.add(node.name);
        const uv = scalars(primitive.attributes.TEXCOORD_0, 2);
        const indices = scalars(primitive.indices, 1).flat();
        for (let index = 0; index < indices.length; index += 3) {
          const points = indices.slice(index, index + 3).map((vertex) => uv[vertex]);
          const u = points.reduce((sum, point) => sum + point[0], 0) / 3;
          const v = points.reduce((sum, point) => sum + point[1], 0) / 3;
          const inside = v < (region.max_v ?? 1)
            && region.tiles.some(([x, y]) => x === Math.floor(u * 8) && y === Math.floor(v * 4));
          assert.equal(dyed, inside, `${item.wearable_key}/${node.name}/${index / 3}`);
        }
      }
    }
    assert.deepEqual([...dyedNodes].sort(), Object.keys(nodes).sort(), item.wearable_key);
  }
});

// 本地发型使用整张中性贴图，只蒙皮到现有头骨。
test('本地发型交付为可染色且独立的头部网格', async () => {
  const { wearables } = await readJSON('internal/character/character-catalog.json');
  const recipe = await readJSON('scripts/local-hairstyle-sources.json');
  const palette = await readJSON('internal/character/wearable-colors.json');
  const { wearables: sources } = await readJSON('internal/assets/local-hairstyle-source-manifest.json');
  const { hex } = palette.find((color) => color.key === recipe.default_color_key);
  const defaultColor = hex.slice(1).match(/../g).map((channel) => {
    const srgb = parseInt(channel, 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  const expected = Object.keys(recipe.styles).map((number) => 'hair-local-' + number).sort();
  const items = wearables.filter((item) => item.pack_key === recipe.pack_key);
  assert.deepEqual(items.map((item) => item.wearable_key).sort(), expected);
  assert.deepEqual(sources.map((item) => item.wearable_key).sort(), expected);
  for (const item of items) {
    const source = sources.find((entry) => entry.wearable_key === item.wearable_key);
    assert.equal(item.slot, 'head');
    assert.equal(item.sellable, true);
    assert.equal(item.default_color_key, recipe.default_color_key);
    assert.equal(source.model_asset_key, item.model_asset_key);
    assert.equal(source.thumbnail_asset_key, item.thumbnail_asset_key);
    const { document, primitives, scalars } = await readWearableMesh(item);
    const meshes = document.nodes.filter((node) => node.mesh !== undefined);
    assert.deepEqual(meshes.map((node) => node.name), item.nodes);
    const skin = document.skins[meshes[0].skin];
    for (const primitive of primitives) {
      const material = document.materials[primitive.material];
      assert.equal(material.name, item.dye_material);
      const { baseColorTexture, baseColorFactor } = material.pbrMetallicRoughness;
      const texture = document.textures[baseColorTexture.index];
      assert.ok(document.images[texture.source].bufferView !== undefined);
      assert.ok(defaultColor.every((channel, index) => Math.abs(channel - baseColorFactor[index]) < 1e-6), item.wearable_key);
      assert.equal(primitive.attributes.COLOR_0, undefined);
      const joints = scalars(primitive.attributes.JOINTS_0, 4);
      const weights = scalars(primitive.attributes.WEIGHTS_0, 4);
      for (const [index, row] of weights.entries()) {
        assert.ok(row.some((weight, column) => weight === 1
          && document.nodes[skin.joints[joints[index][column]]].name === 'head'), item.wearable_key);
      }
    }
  }
});

// BearHat 源节点有 1030 个三角面，胡须来自另一个节点的独立 UV 区域。
test('棕色熊帽保留原帽网格，去除灰色胡须', async () => {
  const catalog = await readJSON('internal/character/character-catalog.json');
  const hat = catalog.wearables.find((item) => item.wearable_key === 'kaykit-adventurers-barbarian-head');
  const { primitives, scalars } = await readWearableMesh(hat);
  let triangleCount = 0;
  let beardTriangleCount = 0;
  for (const primitive of primitives) {
    const coordinates = scalars(primitive.attributes.TEXCOORD_0, 2);
    const indices = scalars(primitive.indices, 1).flat();
    triangleCount += indices.length / 3;
    for (let index = 0; index < indices.length; index += 3) {
      const [a, b, c] = indices.slice(index, index + 3).map((vertex) => coordinates[vertex]);
      const u = (a[0] + b[0] + c[0]) / 3;
      const v = (a[1] + b[1] + c[1]) / 3;
      // glTF 的 V 轴朝下，对应 Blender 的 0.75 至 1。
      if (u >= 0.125 && u < 0.25 && v <= 0.25) beardTriangleCount++;
    }
  }
  assert.equal(beardTriangleCount, 0, '帽子仍包含胡须三角面');
  assert.equal(triangleCount, 1030);
});

// 从正式GLB的真实三角面检查鼻下前脸，不能以网格非空替代嘴和下颌完整性。
test('独立脸型保留嘴部和下颌的实际表面', async () => {
  const catalog = await readJSON('internal/character/character-catalog.json');
  const face = catalog.wearables.find((entry) => entry.wearable_key === 'face-kaykit-adventurers-ranger');
  const { primitives, scalars } = await readWearableMesh(face);
  const triangles = [];
  for (const primitive of primitives) {
    const positions = scalars(primitive.attributes.POSITION, 3);
    const indices = primitive.indices === undefined ? positions.map((_, index) => index) : scalars(primitive.indices, 1).flat();
    for (let index = 0; index < indices.length; index += 3) triangles.push(indices.slice(index, index + 3).map((vertex) => positions[vertex]));
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
