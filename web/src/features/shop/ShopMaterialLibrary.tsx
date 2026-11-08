import { useEffect, useId, useState } from 'react';
import { ViewTabs } from '../../components/ViewTabs';
import islandContent from '../island/three/spatial-content.json';
import { ShopItemArtwork } from './ShopItemArtwork';
import { shopCategoryName, shopCategoryTabs, shopGroups } from './shop-categories';
import type { ShopGroup } from './shop-categories';
import type { ManagementMaterial, ManagementMaterials, ShopClient } from './types';
import { shopError } from './helpers';
import content from './content.json';

type MaterialGroup = ShopGroup | 'activities';

const groups = [...shopGroups, { id: 'activities', label: content.materialActivities }] as const;
const batchSize = 48;

// 素材来源于已安装目录。可售性和动作绑定由服务端提供。
interface ShopMaterialLibraryProps {
  client: ShopClient; // 当前账户的管理会话。
  initialGroup: ShopGroup; // 从商品列表进入时沿用分组。
  initialCategory: string; // 从商品列表进入时沿用分类。
  createPending: boolean; // 已有结果未知的创建请求，须先核对。
  onCreate: (material: ManagementMaterial) => void; // 打开固定素材的报价表单。
}

// 只读取素材元数据，列表不会加载动作或模型文件。
export function ShopMaterialLibrary({ client, initialGroup, initialCategory, createPending, onCreate }: ShopMaterialLibraryProps) {
  const searchId = useId();
  const [group, setGroup] = useState<MaterialGroup>(initialGroup);
  const [category, setCategory] = useState(initialCategory);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(batchSize);
  const [data, setData] = useState<ManagementMaterials | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, refresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void client.request<ManagementMaterials>('/management/materials', { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setData(result);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason);
    });
    return () => controller.abort();
  }, [client, revision]);

  const term = search.trim().toLocaleLowerCase();
  const materials = data?.items.filter(({ asset, group: assetGroup, category: assetCategory }) =>
    assetGroup === group && (!category || assetCategory === category) &&
    [asset.name, asset.key, asset.provider, asset.pack_name, asset.pack_key].some((value) => value?.toLocaleLowerCase().includes(term))) ?? [];
  const campCategories = [...new Set(data?.items.filter((item) => item.group === 'camp').map((item) => item.category))];
  // 商品分组可能还没有对应素材可选，保留从目录进入时选中的分类。
  if (group === 'camp' && category && !campCategories.includes(category)) campCategories.push(category);

  if (error !== null) return <div role="alert">
    <p className="shop-error">{shopError(error)}</p>
    <button type="button" className="secondary" onClick={() => refresh((value) => value + 1)}>{content.reload}</button>
  </div>;
  if (!data) return <p role="status">{content.loading}</p>;

  return <div className="shop-categories">
    <ViewTabs label={content.materialGroupLabel} items={groups} value={group} onChange={(next) => {
      if (next !== group) { setGroup(next); setCategory(''); setLimit(batchSize); }
    }} className="shop-category-tabs" panelClassName="shop-category-panel">
      {group === 'activities' ? <ActivityMaterials activities={data.activities} /> : <ViewTabs
        label={group === 'appearance' ? content.categoryDetailLabel : content.campCategoryLabel}
        items={shopCategoryTabs(group, campCategories)} value={category} onChange={(next) => { setCategory(next); setLimit(batchSize); }}
        className="shop-category-tabs shop-category-details">
        <div className="shop-material-search">
          <label htmlFor={searchId}>{content.assetSearchLabel}</label>
          <input id={searchId} type="search" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(batchSize); }} />
        </div>
        {materials.length === 0 && <p>{content.emptyMaterials}</p>}
        <div className="shop-grid shop-management-grid">
          {materials.slice(0, limit).map((material) => <article key={`${material.group}/${material.category}/${material.asset.key}`} className="shop-card shop-product-card shop-management-card shop-material-card">
            <h3>{material.asset.name}</h3>
            <ShopItemArtwork item={material.asset} className="shop-item-art shop-product-art" />
            <p>{shopCategoryName(group, material.category)}</p>
            {material.saleable
              ? <button type="button" className="secondary" disabled={createPending} aria-label={`${content.addProduct} ${material.asset.name}`}
                onClick={(event) => { event.currentTarget.focus(); onCreate(material); }}>{content.addProduct}</button>
              : <p>{content.materialNotForSale}</p>}
          </article>)}
        </div>
        {materials.length > limit && <button type="button" className="secondary" onClick={() => setLimit((value) => value + batchSize)}>{content.moreAssets}</button>}
      </ViewTabs>}
    </ViewTabs>
  </div>;
}

// 每行呈现场景内活动对指定身体使用的动作片段，以及可选的道具素材。
function ActivityMaterials({ activities }: { activities: ManagementMaterials['activities'] }) {
  if (!activities.length) return <p>{content.emptyMaterialActivities}</p>;
  const activityLabels: Readonly<Record<string, string>> = islandContent.activities;
  return <div className="shop-material-table-scroll" role="region" aria-label={content.materialActivities} tabIndex={0}>
    <table className="shop-material-table">
      <thead><tr>
        <th scope="col">{content.categoryGroups.scene}</th>
        <th scope="col">{content.materialActivity}</th>
        <th scope="col">{content.types.character}</th>
        <th scope="col">{content.materialClip}</th>
        <th scope="col">{content.materialAnimation}</th>
        <th scope="col">{content.materialAttachment}</th>
      </tr></thead>
      <tbody>{activities.map((binding) => <tr key={`${binding.scene_key}/${binding.activity}/${binding.character_key}`}>
        <td>{binding.scene_name}</td>
        <td>{activityLabels[binding.activity] ?? binding.activity}</td>
        <td>{binding.character_name}</td>
        <td><code>{binding.clip}</code></td>
        <td><code>{binding.asset_key}</code></td>
        <td>{binding.attachment_asset_key && <code>{binding.attachment_asset_key}</code>}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}
