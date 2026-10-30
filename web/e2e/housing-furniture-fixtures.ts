import type { components } from '../src/api/schema';

type Placement = components['schemas']['IslandPlacement'];
type OwnedItem = components['schemas']['IslandOwnedItem'];

// 实际占地样例同时容纳全套家具、两把餐椅和原有书桌，并保留房门及卫生间通路。
export const familyFurniturePositions = [
  { item_key: 'bed', x: -3.75, y: -2.5 },
  { item_key: 'cabinet', x: -3.5, y: -0.5 },
  { item_key: 'sofa', x: -3.5, y: 0.75 },
  { item_key: 'coffee-table', x: -3.5, y: 2.25 },
  { item_key: 'television', x: -3.5, y: 3.5 },
  { item_key: 'kitchen-counter', x: -0.25, y: -3.5 },
  { item_key: 'refrigerator', x: 1.75, y: -3.5 },
  { item_key: 'dining-table', x: 1, y: 0 },
  { item_key: 'dining-chair', x: 1, y: -1.25 },
  { item_key: 'dining-chair', x: 1, y: 1.25 },
  { item_key: 'toilet', x: 2.75, y: -3.25 },
  { item_key: 'washbasin', x: 2.75, y: -2 },
  { item_key: 'shower', x: 4.25, y: -3.25 },
] as const;

// 稳定实例来自真实购买；同种餐椅逐件消费，不复用订单身份。
export function familyHomePlacements(inventory: OwnedItem[]): Placement[] {
  const remaining = [...inventory];
  const furniture: Placement[] = familyFurniturePositions.map((position) => {
    const index = remaining.findIndex((item) => item.item_key === position.item_key);
    if (index < 0) throw new Error(`Missing owned furniture: ${position.item_key}`);
    const owned = remaining.splice(index, 1)[0]!;
    return { ...position, id: owned.id, rotation: 0, zone: 'indoor' };
  });
  return [
    { id: 'base:house', item_key: 'house', x: -1.5, y: -2, rotation: 0, zone: 'outdoor' },
    { id: 'base:desk', item_key: 'desk', x: -0.75, y: -0.25, rotation: 0, zone: 'indoor' },
    { id: 'base:run', item_key: 'run', x: 3.25, y: 4, rotation: 0, zone: 'outdoor' },
    { id: 'base:environment', item_key: 'day', x: 0, y: 0, rotation: 0, zone: 'outdoor' },
    ...furniture,
  ];
}
