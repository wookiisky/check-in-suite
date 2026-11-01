import { useMemo, useState } from 'react';
import type { RefObject } from 'react';
import type { SpatialIslandState, SpatialPlacement, SpatialSpace } from './spatial-ui-types';
import content from './spatial-content.json';
import browserContent from './spatial-inventory-content.json';
import './spatial-inventory.css';

const batchSize = 24;
const providerNames: Record<string, string> = browserContent.providers;
const categoryNames: Record<string, string> = browserContent.categories;

/** 筛选只控制列表显示，不修改完整库存或场景草稿。 */
interface InventoryFilters {
  search: string; // 按物品名称匹配。
  provider: string; // 官方来源或内置资源。
  pack: string; // 来源目录中的稳定素材包身份。
  category: string; // 导入时审核确定的物件类别。
}
const emptyFilters: InventoryFilters = { search: '', provider: '', pack: '', category: '' };

/** 库存展示完整所有权，不受商店分页或是否已摆放影响。 */
interface SpatialInventoryProps {
  state:SpatialIslandState; // 当前草稿快照。
  selected:SpatialPlacement|undefined; // 当前可微调物件。
  space:SpatialSpace; // 当前库存分区。
  expanded:boolean; // 手机也可收起列表，保存栏仍保留。
  busy:boolean; // 保存或未知结果时锁定修改。
  saving:boolean; // 保存中的反馈。
  saveDisabled:boolean; // 完整占地或冲突待处理。
  panelRef:RefObject<HTMLElement|null>; // 相机测量可见区域。
  onToggle:()=>void; // 只收起列表。
  onSpace:(space:SpatialSpace)=>void; // 同步查看室内。
  onChoose:(instanceId:string)=>void; // 选择或摆放库存实例。
  onMove:(dx:number,dz:number)=>void; // 十厘米微调。
  onRotate:()=>void; // 目录允许的90度旋转。
  onStore:()=>void; // 主屋不提供收起。
  onSave:()=>void; // 保存整套草稿。
  onCancel:()=>void; // 恢复已保存布局。
  onEnvironment:(key:string)=>void; // 独立环境设置。
}
// 列表内部滚动，选中物品工具和保存取消留在固定区域。
export function SpatialInventory(props:SpatialInventoryProps){
  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState({ space: props.space, limit: batchSize });
  const catalog = useMemo(() => new Map(props.state.catalog.map((item) => [item.item_key, item])), [props.state.catalog]);
  const definition=props.selected ? catalog.get(props.selected.item_key) : undefined;
  const isHouse=definition?.assembly==='house';
  const items = useMemo(() => {
    const counts = new Map<string, number>();
    return props.state.inventory.flatMap((item) => {
      const current = catalog.get(item.item_key);
      if (!current) return [];
      const count = (counts.get(item.item_key) ?? 0) + 1;
      counts.set(item.item_key, count);
      const name = count === 1 ? current.name : content.additionalInstance.replace('{name}', current.name).replace('{number}', String(count));
      return [{ ...item, current, name }];
    });
  }, [catalog, props.state.inventory]);
  const placedInstances = useMemo(() => new Set(props.state.placements.map((item) => item.instance_id)), [props.state.placements]);
  const inSpace = items.filter((item) => item.current.spaces.includes(props.space));
  const providers = [...new Set(inSpace.map((item) => item.current.provider || 'builtin'))].sort();
  const packs = new Map(inSpace.filter((item) => !filters.provider || (item.current.provider || 'builtin') === filters.provider).flatMap((item) => item.current.pack_key ? [[item.current.pack_key, item.current.pack_name || item.current.pack_key.replaceAll('-', ' ')] as const] : []));
  const categories = [...new Set(inSpace.flatMap((item) => item.current.category ? [item.current.category] : []))].sort();
  const query = filters.search.trim().toLocaleLowerCase();
  const filtered = inSpace.filter(({ current, name }) =>
    (!query || name.toLocaleLowerCase().includes(query)) &&
    (!filters.provider || (current.provider || 'builtin') === filters.provider) &&
    (!filters.pack || current.pack_key === filters.pack) &&
    (!filters.category || current.category === filters.category));
  const limit = page.space === props.space ? page.limit : batchSize;
  const visible = filtered.slice(0, limit);
  const hasFilters = Boolean(filters.search || filters.provider || filters.pack || filters.category);

  // 更换条件从首批开始，避免旧列表页数造成空白或一次绘制过多卡片。
  function changeFilters(next: InventoryFilters) {
    setFilters(next);
    setPage({ space: props.space, limit: batchSize });
  }
  return <aside ref={props.panelRef} className={`spatial-inventory ${props.expanded?'is-expanded':'is-collapsed'}`} aria-label={content.inventory}>
    <header><h2>{!props.expanded&&definition?definition.name:content.inventory}</h2><button className="secondary" aria-label={props.expanded?content.hideInventory:content.showInventory} aria-expanded={props.expanded} onClick={props.onToggle}>{props.expanded?'−':'+'}</button></header>
    {props.expanded&&<div className="spatial-inventory-browser">
      <div className="spatial-tabs"><button className={props.space==='outdoor'?'is-active':'secondary'} aria-pressed={props.space==='outdoor'} onClick={()=>{setPage({ space: 'outdoor', limit: batchSize });props.onSpace('outdoor');}}>{content.outdoorItems}</button><button className={props.space==='indoor'?'is-active':'secondary'} aria-pressed={props.space==='indoor'} onClick={()=>{setPage({ space: 'indoor', limit: batchSize });props.onSpace('indoor');}}>{content.indoorItems}</button></div>
      <fieldset className="spatial-inventory-filters" aria-label={browserContent.filters}>
        <label className="spatial-inventory-search">{browserContent.search}<input type="search" value={filters.search} placeholder={browserContent.searchPlaceholder} onChange={(event) => changeFilters({ ...filters, search: event.target.value })} /></label>
        <label>{browserContent.provider}<select value={filters.provider} onChange={(event) => changeFilters({ ...filters, provider: event.target.value, pack: '' })}><option value="">{browserContent.allProviders}</option>{providers.map((key) => <option key={key} value={key}>{key === 'builtin' ? browserContent.builtin : providerNames[key] || key}</option>)}</select></label>
        <label>{browserContent.category}<select value={filters.category} onChange={(event) => changeFilters({ ...filters, category: event.target.value })}><option value="">{browserContent.allCategories}</option>{categories.map((key) => <option key={key} value={key}>{categoryNames[key] || key}</option>)}</select></label>
        <label className="spatial-inventory-pack">{browserContent.pack}<select value={filters.pack} onChange={(event) => changeFilters({ ...filters, pack: event.target.value })}><option value="">{browserContent.allPacks}</option>{[...packs].sort((a, b) => a[1].localeCompare(b[1])).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      </fieldset>
      <div className="spatial-inventory-results"><small role="status">{browserContent.results.replace('{shown}', String(visible.length)).replace('{total}', String(filtered.length))}</small>{hasFilters && <button className="secondary" onClick={() => changeFilters(emptyFilters)}>{browserContent.clearFilters}</button>}</div>
      <div className="spatial-inventory-list">{visible.map(item=>{
        const placed=placedInstances.has(item.instance_id),selected=item.instance_id===props.selected?.instance_id;
        return <button key={item.instance_id} className={`spatial-item secondary ${selected?'is-selected':''}`} disabled={props.busy} aria-pressed={selected} aria-label={(placed?content.select:content.add).replace('{name}',item.name)} onClick={()=>props.onChoose(item.instance_id)}>
          <img src={item.current.thumbnail_url} alt="" loading="lazy" decoding="async" width={56} height={56}/><span><strong>{item.name}</strong><small>{placed?content.placed:content.stored}</small></span>
        </button>;
      })}{!filtered.length&&<p>{inSpace.length ? browserContent.noMatches : content.emptyInventory}</p>}</div>
      {visible.length < filtered.length && <button className="secondary spatial-inventory-more" onClick={() => setPage({ space: props.space, limit: limit + batchSize })}>{browserContent.loadMore}</button>}
      <label className="spatial-environment">{content.environment}<select value={props.state.environment_key} disabled={props.busy} onChange={event=>props.onEnvironment(event.target.value)}>{props.state.scene.environments.map(key=><option key={key} value={key}>{content.environments[key as keyof typeof content.environments]??key}</option>)}</select></label>
    </div>}
    {props.selected&&<section className="spatial-selected" aria-label={definition?.name}>
      <strong>{definition?.name}</strong><span>{content.position} {props.selected.x_cm}, {props.selected.z_cm}</span>
      {isHouse&&<small>{content.houseRequired}</small>}
      <div className="spatial-adjust"><button className="secondary" disabled={props.busy||!definition?.movable} aria-label={content.moveLeft} onClick={()=>props.onMove(-10,0)}>←</button><button className="secondary" disabled={props.busy||!definition?.movable} aria-label={content.moveBack} onClick={()=>props.onMove(0,-10)}>↑</button><button className="secondary" disabled={props.busy||!definition?.movable} aria-label={content.moveForward} onClick={()=>props.onMove(0,10)}>↓</button><button className="secondary" disabled={props.busy||!definition?.movable} aria-label={content.moveRight} onClick={()=>props.onMove(10,0)}>→</button></div>
      <div className="spatial-item-actions"><button className="secondary" disabled={props.busy||isHouse||!definition?.movable||(definition?.rotations.length??0)<2} onClick={props.onRotate}>{content.rotate}</button><button className="secondary" disabled={props.busy||isHouse||!definition?.movable} onClick={props.onStore}>{content.store}</button></div>
    </section>}
    <footer><button disabled={props.saveDisabled||props.busy} onClick={props.onSave}>{props.saving?content.saving:content.save}</button><button className="secondary" disabled={props.busy} onClick={props.onCancel}>{content.cancel}</button></footer>
  </aside>;
}
