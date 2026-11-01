import { Modal } from '../../../components/Modal';
import content from './scene-picker-content.json';
import './scene-picker.css';

/** 列表只描述空间资格；人物和物品模型仍由当前场景按需加载。 */
export interface SpatialSceneChoice {
  scene_key:string; // 购买后保持稳定的空间身份。
  name:string; // 服务端配置的场景名称。
  thumbnail_url:string; // 静态场景预览。
  free:boolean; // 免费空间不需要订单。
  owned:boolean; // 永久资格由服务端完整订单提供。
}

/** 选择与购买分开，未拥有场景不发起布局读取。 */
interface ScenePickerProps {
  scenes:SpatialSceneChoice[]; // 当前场景目录与资格。
  current:string; // 本设备当前查看的空间。
  loading:boolean; // 列表读取状态。
  error:unknown; // 列表读取失败，不影响当前场景。
  onChoose:(key:string)=>void; // 交给页面处理未保存草稿。
  onPurchase?:()=>void; // 进入现有商店购买流程。
  onRetry:()=>void; // 明确重试只读请求。
  onClose:()=>void; // 关闭选择器不改变布局。
}

// 使用原生按钮保留键盘和触摸操作，卡片图片不创建额外 Canvas。
export function ScenePicker(props:ScenePickerProps) {
  return <Modal title={content.title} onClose={props.onClose}>
    <p>{content.hint}</p>
    {props.loading&&<p role="status">{content.loading}</p>}
    {props.error!==null&&<div><p role="alert">{content.error}</p><button onClick={props.onRetry}>{content.retry}</button></div>}
    <div className="spatial-scene-list">{props.scenes.map(scene=><section className="spatial-scene-card" key={scene.scene_key}>
      <img src={scene.thumbnail_url} alt="" width={120} height={90} loading="lazy" />
      <div><h3>{scene.name}</h3><p>{scene.free?content.free:scene.owned?content.owned:content.locked}</p></div>
      {scene.scene_key===props.current?<button disabled>{content.current}</button>:scene.owned||scene.free?<button onClick={()=>props.onChoose(scene.scene_key)}>{content.go.replace('{name}',scene.name)}</button>:<button className="secondary" disabled={!props.onPurchase} onClick={props.onPurchase}>{content.buy.replace('{name}',scene.name)}</button>}
    </section>)}</div>
  </Modal>;
}
