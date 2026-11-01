import { createRef } from 'react';
import { vi } from 'vitest';
import configuration from '../../../../../internal/island/spatial-scene.json';
import type { SpatialDefinition, SpatialIslandState } from './spatial-ui-types';

// 库存包含独立实例，目录元数据仅决定筛选，不代替所有权。
export function inventoryFixture(count = 55) {
  const state: SpatialIslandState = {
    version: 1,
    scene_key: configuration.scene.scene_key,
    environment_key: 'day',
    scene: structuredClone(configuration.scene) as SpatialIslandState['scene'],
    catalog: [],
    inventory: [],
    placements: [],
  };
  const base = configuration.catalog.find((item) => item.item_key === 'camp-dining-chair-v1')! as SpatialDefinition;
  for (let index = 0; index < count; index++) {
    state.catalog.push({
      ...base,
      item_key: `item-${index}`,
      name: `摆设 ${index}`,
      spaces: index === count - 1 ? ['indoor'] : ['outdoor', 'indoor'],
      rotations: [0, 1, 2, 3],
      allowed_terrain: ['grass'],
      ...{ provider: index % 2 ? 'kaykit' : 'kenney', pack_key: index % 2 ? 'forest' : 'furniture-kit', pack_name: index % 2 ? 'Forest' : 'Furniture Kit', category: index % 2 ? 'nature' : 'furniture' },
    });
    state.inventory.push({ instance_id: `owned-${index}`, item_key: `item-${index}` });
  }
  return {
    state,
    selected: undefined,
    space: 'outdoor' as const,
    expanded: true,
    busy: false,
    saving: false,
    saveDisabled: false,
    panelRef: createRef<HTMLElement>(),
    onToggle: vi.fn(),
    onSpace: vi.fn(),
    onChoose: vi.fn(),
    onMove: vi.fn(),
    onRotate: vi.fn(),
    onStore: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    onEnvironment: vi.fn(),
  };
}
