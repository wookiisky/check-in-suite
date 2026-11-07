import { useEffect } from 'react';
import { vi } from 'vitest';
import type { ApiClient, RequestOptions } from '../../api/client';
import type { components } from '../../api/schema';
import type { ComponentProps } from 'react';
import type { CharacterPreview3D } from '../character/CharacterPreview3D';

type AppearanceState = components['schemas']['AppearanceState'];
const fixtureSlots = ['face', 'head', 'upper', 'lower', 'shoes', 'back'] as const;
const slotNames = { face: '形象', head: '头部', upper: '上装', lower: '下装', shoes: '鞋子', back: '背部' };

// 测试目录保留完整协议结构，部件名称不依赖实际商品或模型版本。
export function appearanceFixture(version = 1): AppearanceState {
  return {
    version, character_key: 'body-fixture', face_purchase_id: null, back_purchase_id: null, head_purchase_id: null, upper_purchase_id: null, lower_purchase_id: null, shoes_purchase_id: null,
    characters: [{ name: '测试人物', character_key: 'body-fixture', rig_key: 'rig-fixture', model_asset_key: 'body-model', model_url: '/body.glb', scale: 1, fixed_nodes: ['face'], body_regions: { torso: ['torso'] }, defaults: { face: 'face-default', back: 'back-default', head: 'head-default', upper: 'upper-default', lower: 'lower-default', shoes: 'shoes-default' }, animations: { idle: { clip: 'Idle', asset_key: 'body-model', url: '/body.glb' } } }],
    wearables: fixtureSlots.flatMap((slot) => ['default', 'owned'].map((kind) => ({ name: `${slotNames[slot]}${kind === 'default' ? '默认款' : '新款'}`, wearable_key: `${slot}-${kind}`, slot, character_key: 'body-fixture', rig_key: 'rig-fixture', model_asset_key: 'body-model', model_url: '/body.glb', thumbnail_asset_key: `${slot}-${kind}-thumb`, thumbnail_url: `/${slot}-${kind}.png`, nodes: [`${slot}-${kind}`], covers: slot === 'upper' ? ['torso'] : [] }))),
    inventory: fixtureSlots.map((slot) => ({ purchase_id: `${slot}-purchase`, wearable_key: `${slot}-owned` })),
  };
}

// 请求完成时间由测试控制，便于证明迟到读取不能覆盖新状态。
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

// Fake 只负责请求排程，真实协议与事务由 Go HTTP 测试覆盖。
export function appearanceClient(handler: (path: string, options: RequestOptions) => Promise<unknown>) {
  const request = vi.fn((path: string, options: RequestOptions = {}) => handler(path, options));
  return { client: { request: request as ApiClient['request'] }, request };
}

// WebGL 由父级浏览器验证；组件测试只模拟独立的模型状态回调。
export function AppearancePreviewFake({ draft, onStatus }: ComponentProps<typeof CharacterPreview3D>) {
  useEffect(() => { onStatus?.({ phase: 'ready' }); }, [draft, onStatus]);
  return <div><output data-testid="appearance-preview-draft">{JSON.stringify(draft)}</output><button type="button" onClick={() => onStatus?.({ phase: 'error', error: new Error('MODEL_FAILED') })}>模拟模型失败</button></div>;
}
