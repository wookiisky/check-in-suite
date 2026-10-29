import type { Equipment } from './types';

export type AccessoryLayout = Equipment['accessory_layouts'][string];
export type AccessoryLayoutInput = Pick<AccessoryLayout, 'x' | 'y' | 'size'> & {
  before_id: string | null; // 放在该饰品或角色之前，null表示最前方。
};

// 角色是固定参照层，排序时也参与逐层移动。
export const avatarLayerID = 'avatar';

// 装备协议保证每个已装备饰品都有服务端保存的布局。
export function accessoryLayout(equipment: Equipment, id: string): AccessoryLayout {
  return equipment.accessory_layouts[id]!;
}

// 把角色加入排序，使饰品可从角色前面逐层移到后面。
export function accessoryOrder(equipment: Equipment): string[] {
  return [...equipment.accessories.map((item) => item.id), avatarLayerID].sort((a, b) =>
    (a === avatarLayerID ? 0 : accessoryLayout(equipment, a).layer) -
    (b === avatarLayerID ? 0 : accessoryLayout(equipment, b).layer),
  );
}

// 坐标以画布为基准，正方形图片容器保持完全在画布内。
export function clampLayout(layout: AccessoryLayout): AccessoryLayout {
  const size = Math.min(1, Math.max(0.05, layout.size));
  const half = size / 2;
  return { ...layout, size, x: Math.max(half, Math.min(1 - half, layout.x)), y: Math.max(half, Math.min(1 - half, layout.y)) };
}

// 草稿仅替换选中饰品的位置尺寸，排序层号以角色为零重新分配。
export function previewEquipment(equipment: Equipment, id: string, layout: AccessoryLayout, order: string[]): Equipment {
  const avatarIndex = order.indexOf(avatarLayerID);
  const layouts = Object.fromEntries(equipment.accessories.map((item) => [item.id, {
    ...(item.id === id ? layout : accessoryLayout(equipment, item.id)),
    layer: order.indexOf(item.id) - avatarIndex,
  }]));
  return { ...equipment, accessory_layouts: layouts };
}
