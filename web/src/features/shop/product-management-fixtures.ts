import type { ManagementMaterial, ManagementMaterials, Product } from './types';

export const managedMaterial: ManagementMaterial = {
  asset: { key: 'catalog-preview-q', name: '森林款', kind: 'wearable', url: '/catalog-preview-q.png' },
  group: 'appearance', category: 'upper', saleable: true,
};

export const managedMaterials: ManagementMaterials = {
  items: [
    managedMaterial,
    { ...managedMaterial, asset: { ...managedMaterial.asset, key: 'free-upper', name: '免费上装' }, saleable: false },
  ],
  activities: [{
    scene_key: 'seaside-v1', scene_name: '海边营地', activity: 'read', character_key: 'human', character_name: '人形',
    asset_key: 'reading-animation', clip: 'Read_Seated', attachment_asset_key: 'activity-reading-book-v1',
  }],
};

export const managedWearable: Product = {
  id: 'managed-wearable', type: 'wearable', name: '森林服装',
  asset_key: managedMaterial.asset.key, wearable_key: 'catalog-choice-z', description: '',
  coin_price: 10, diamond_price: 2, stock: 3, enabled: true, version: 1, owned: false, owned_count: 0,
};
