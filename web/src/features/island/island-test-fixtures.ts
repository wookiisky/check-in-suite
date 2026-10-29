import type { IslandDefinition, IslandState } from './island-types';

// 测试目录与正式服务资源分离，覆盖单选、室内和重复购买。
export const definitions: IslandDefinition[] = [
  { key: 'house', name: '小木屋', category: 'house', model: 'house', width: 8, depth: 6, movable: true, repeatable: false },
  { key: 'desk', name: '书桌', category: 'equipment', model: 'desk', width: 1, depth: 1, movable: true, repeatable: false, activity: 'read' },
  { key: 'run', name: '运动区', category: 'equipment', model: 'run', width: 2, depth: 2, movable: true, repeatable: false, activity: 'run' },
  { key: 'day', name: '晴日', category: 'environment', model: 'day', width: 0, depth: 0, movable: false, repeatable: false },
  { key: 'tree', name: '树木', category: 'decoration', model: 'tree', width: 1, depth: 1, movable: true, repeatable: true },
];

// 免费基础物品和未摆放的购买实例构成一个真实页面响应。
export const state: IslandState = {
  version: 1,
  today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()),
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  activity_access: [
    { activity: 'read', available: true, tasks: [] },
    { activity: 'run', available: true, tasks: [] },
    { activity: 'ball', available: true, tasks: [] },
  ],
  catalog: definitions,
  inventory: [
    { id: 'base:house', item_key: 'house' }, { id: 'base:desk', item_key: 'desk' },
    { id: 'base:run', item_key: 'run' }, { id: 'base:environment', item_key: 'day' },
    { id: 'tree-1', item_key: 'tree' }, { id: 'tree-2', item_key: 'tree' },
  ],
  placements: [
    { id: 'base:house', item_key: 'house', x: -3, y: -2, rotation: 0, zone: 'outdoor' },
    { id: 'base:desk', item_key: 'desk', x: 0, y: 0, rotation: 0, zone: 'indoor' },
    { id: 'base:run', item_key: 'run', x: 3, y: 2, rotation: 0, zone: 'outdoor' },
    { id: 'base:environment', item_key: 'day', x: 0, y: 0, rotation: 0, zone: 'outdoor' },
  ],
};
