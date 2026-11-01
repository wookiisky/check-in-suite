import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 只解析 GLB 容器；该工具用于素材审查，不替代完整 glTF 校验器。
function readContainer(buffer) {
  if (buffer.length < 12) throw new Error('GLB_HEADER: 文件头不完整。');
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('GLB_MAGIC: 文件不是 GLB。');
  if (buffer.readUInt32LE(4) !== 2) throw new Error('GLB_VERSION: 只支持 GLB 2.0。');
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error('GLB_LENGTH: 声明长度与实际长度不同。');
  let document;
  let binary;
  let offset = 12;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('GLB_CHUNK: chunk 头不完整。');
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    if (length % 4 || offset + 8 + length > buffer.length) throw new Error('GLB_CHUNK: chunk 长度无效。');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (offset === 12 && type !== 0x4e4f534a) throw new Error('GLB_JSON: 首个 chunk 必须是 JSON。');
    if (type === 0x4e4f534a) {
      if (document) throw new Error('GLB_JSON: JSON chunk 重复。');
      document = JSON.parse(data.toString('utf8'));
    }
    if (type === 0x004e4942) binary = data;
    offset += 8 + length;
  }
  if (!document) throw new Error('GLB_JSON: 缺少 JSON chunk。');
  return { document, binary };
}

// 变换保留源数据，不把局部范围误报为世界尺寸。
function transform(node) {
  return Object.fromEntries(['matrix', 'translation', 'rotation', 'scale']
    .filter((key) => node[key] !== undefined).map((key) => [key, node[key]]));
}

// 优先读取真实时间采样；外链 buffer 的时长只在声明了 max 时提供。
function lastTime(document, binary, index) {
  const accessor = document.accessors?.[index];
  if (!accessor) return null;
  const view = document.bufferViews?.[accessor.bufferView];
  if (binary && view?.buffer === 0 && !document.buffers?.[0]?.uri && accessor.componentType === 5126 && accessor.type === 'SCALAR' && !accessor.sparse) {
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const stride = view.byteStride ?? 4;
    let maximum = 0;
    for (let sample = 0; sample < accessor.count; sample++) {
      maximum = Math.max(maximum, binary.readFloatLE(start + sample * stride));
    }
    return maximum;
  }
  return accessor.max?.[0] ?? null;
}

// 汇总源模型结构，供人工判断拆装、骨架和动画加工范围。
export function inspectGLB(buffer) {
  const { document, binary } = readContainer(buffer);
  const nodes = document.nodes ?? [];
  const parents = new Map();
  nodes.forEach((node, parent) => node.children?.forEach((child) => parents.set(child, parent)));
  const roots = document.scenes?.[document.scene ?? 0]?.nodes ?? nodes.map((_, index) => index).filter((index) => !parents.has(index));
  return {
    asset: document.asset,
    nodes: nodes.map((node, index) => ({
      node: index, name: node.name, parent: parents.get(index) ?? null,
      ...(node.mesh === undefined ? {} : { mesh: node.mesh }),
      ...(node.skin === undefined ? {} : { skin: node.skin }),
      ...transform(node),
    })),
    roots: roots.map((index) => ({ node: index, name: nodes[index]?.name, ...transform(nodes[index]) })),
    skins: (document.skins ?? []).map((skin) => ({
      name: skin.name,
      ...(skin.skeleton === undefined ? {} : { skeleton: skin.skeleton }),
      joints: skin.joints.map((index) => ({ node: index, name: nodes[index]?.name, parent: parents.get(index) ?? null })),
    })),
    meshes: (document.meshes ?? []).map((mesh) => ({
      name: mesh.name,
      positions: mesh.primitives.filter((primitive) => primitive.attributes?.POSITION !== undefined).map((primitive) => {
        const index = primitive.attributes.POSITION;
        const accessor = document.accessors[index];
        return { accessor: index, count: accessor.count, min: accessor.min ?? null, max: accessor.max ?? null };
      }),
    })),
    animations: (document.animations ?? []).map((animation) => {
      const times = animation.samplers.map((sampler) => lastTime(document, binary, sampler.input));
      const properties = {};
      for (const channel of animation.channels) properties[channel.target.path] = (properties[channel.target.path] ?? 0) + 1;
      return {
        name: animation.name,
        // 缺少任一采样时长时不声称已取得完整动作时长。
        duration: times.some((time) => time === null) ? null : Math.max(0, ...times),
        properties,
        targets: animation.channels.map(({ target }) => ({ node: target.node, name: nodes[target.node]?.name, path: target.path })),
      };
    }),
    externalImages: (document.images ?? []).flatMap((image) => image.uri && !image.uri.startsWith('data:') ? [image.uri] : []),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const buffer = await readFile(process.argv[2]);
    console.log(JSON.stringify(inspectGLB(buffer), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
