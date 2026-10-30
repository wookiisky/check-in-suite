import type { Equipment } from './types';

export type AccessoryLayout = Equipment['accessory_layouts'][string];
export type AccessoryLayoutInput = Pick<AccessoryLayout, 'x' | 'y' | 'size' | 'rotation'> & {
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

// 旋转后的整个图片容器留在画布内，先约束尺寸再约束中心。
export function clampLayout(layout: AccessoryLayout): AccessoryLayout {
  const rotation = ((layout.rotation % 360) + 360) % 360;
  const radians = rotation * Math.PI / 180;
  const extent = Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians));
  const size = Math.min(1 / extent, Math.max(0.05, layout.size));
  const half = Math.min(0.5, size * extent / 2);
  return { ...layout, rotation, size, x: Math.max(half, Math.min(1 - half, layout.x)), y: Math.max(half, Math.min(1 - half, layout.y)) };
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
