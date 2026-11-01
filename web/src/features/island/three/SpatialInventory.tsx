import type { RefObject } from 'react';
import type { SpatialIslandState, SpatialPlacement, SpatialSpace } from './spatial-ui-types';
import content from './spatial-content.json';

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
  const definition=props.state.catalog.find(item=>item.item_key===props.selected?.item_key);
  const isHouse=definition?.assembly==='house';
  const counts=new Map<string,number>();
  const names=new Map(props.state.inventory.map(item=>{const count=(counts.get(item.item_key)??0)+1;counts.set(item.item_key,count);const name=props.state.catalog.find(d=>d.item_key===item.item_key)?.name??item.item_key;return [item.instance_id,count===1?name:content.additionalInstance.replace('{name}',name).replace('{number}',String(count))];}));
  return <aside ref={props.panelRef} className={`spatial-inventory ${props.expanded?'is-expanded':'is-collapsed'}`} aria-label={content.inventory}>
    <header><h2>{!props.expanded&&definition?definition.name:content.inventory}</h2><button className="secondary" aria-label={props.expanded?content.hideInventory:content.showInventory} aria-expanded={props.expanded} onClick={props.onToggle}>{props.expanded?'−':'+'}</button></header>
    {props.expanded&&<div className="spatial-inventory-browser">
      <div className="spatial-tabs"><button className={props.space==='outdoor'?'is-active':'secondary'} aria-pressed={props.space==='outdoor'} onClick={()=>props.onSpace('outdoor')}>{content.outdoorItems}</button><button className={props.space==='indoor'?'is-active':'secondary'} aria-pressed={props.space==='indoor'} onClick={()=>props.onSpace('indoor')}>{content.indoorItems}</button></div>
      <div className="spatial-inventory-list">{props.state.inventory.filter(item=>props.state.catalog.find(d=>d.item_key===item.item_key)?.spaces.includes(props.space)).map(item=>{
        const current=props.state.catalog.find(d=>d.item_key===item.item_key)!;
        const placed=props.state.placements.some(p=>p.instance_id===item.instance_id),selected=item.instance_id===props.selected?.instance_id;
        return <button key={item.instance_id} className={`spatial-item secondary ${selected?'is-selected':''}`} disabled={props.busy} aria-pressed={selected} aria-label={(placed?content.select:content.add).replace('{name}',names.get(item.instance_id)!)} onClick={()=>props.onChoose(item.instance_id)}>
          <img src={current.thumbnail_url} alt=""/><span><strong>{names.get(item.instance_id)}</strong><small>{placed?content.placed:content.stored}</small></span>
        </button>;
      })}{!props.state.inventory.some(item=>props.state.catalog.find(d=>d.item_key===item.item_key)?.spaces.includes(props.space))&&<p>{content.emptyInventory}</p>}</div>
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
