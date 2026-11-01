import { Mesh, Texture } from 'three';
import type { AnimationClip, BufferGeometry, Material, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// 渲染只需要模型与动作，不让页面依赖加载器的内部解析状态。
export interface GLTFSource {
  scene: Object3D; // 只由缓存持有的不可变源场景。
  animations: AnimationClip[]; // 只读使用的源动作。
}

// 一个引用在异步加载完成后仍可释放；同源下载不因单个视图取消而中断其他视图。
export interface GLTFLease {
  ready: Promise<GLTFSource>; // 共享的加载结果。
  release: () => void; // 释放一次引用，重复调用不产生副作用。
}

// 缓存条目持有一次下载及当前使用人数。
interface CacheEntry {
  ready: Promise<GLTFSource>; // 该 URL 的唯一在途下载。
  source?: GLTFSource; // 已加载的共享资源。
  references: number; // 等待中或已显示的视图引用数。
}

// 没有实例使用时释放源 GPU 数据；骨骼实例由各人物自行释放。
function disposeSource(source: GLTFSource) {
  const geometries = new Set<BufferGeometry>(); const materials = new Set<Material>(); const textures = new Set<Texture>();
  source.scene.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
}

// 缓存只管理资源存活，人物组装和业务选择属于人物模块。
export class GltfResourceCache {
  private readonly entries = new Map<string, CacheEntry>(); // URL 对应的共享下载。
  private readonly load: (url: string) => Promise<GLTFSource>; // 可注入的真实加载边界。

  // 使用 GLTFLoader 的同源请求；测试可在此精确控制加载完成顺序。
  constructor(load: (url: string) => Promise<GLTFSource> = (url) => new GLTFLoader().loadAsync(url)) { this.load = load; }

  // 提供资源计数用于生命周期检查，不暴露可变缓存数据。
  get size() { return this.entries.size; }

  // 只有最后一个引用释放才销毁共享内容，加载失败不会永久留在缓存。
  acquire(url: string): GLTFLease {
    let entry = this.entries.get(url);
    if (!entry) {
      const created: CacheEntry = { references: 0, ready: Promise.resolve().then(() => this.load(url)) };
      created.ready = created.ready.then((source) => {
        created.source = source;
        if (created.references === 0) disposeSource(source);
        return source;
      }).catch((error: unknown) => {
        if (this.entries.get(url) === created) this.entries.delete(url);
        throw error;
      });
      entry = created; this.entries.set(url, created);
    }
    entry.references++;
    let released = false;
    return {
      ready: entry.ready,
      release: () => {
        if (released) return;
        released = true; entry.references--;
        if (entry.references !== 0) return;
        if (this.entries.get(url) === entry) this.entries.delete(url);
        if (entry.source) disposeSource(entry.source);
      },
    };
  }
}

export const characterResources = new GltfResourceCache();
