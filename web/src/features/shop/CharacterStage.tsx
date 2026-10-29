import { useRef } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import type { Equipment } from './types';
import { accessoryLayout, accessoryOrder, avatarLayerID, clampLayout } from './accessory-layout';
import type { AccessoryLayout } from './accessory-layout';
import { assetURL, portraitAssetKey } from './helpers';
import { useReducedMotion } from './useReducedMotion';
import content from './content.json';
import { HumanCharacterArtwork, isHumanAvatar } from '../character/HumanCharacterArtwork';

// 编辑交互与图片展示共用同一画布，固定背景和特效不参与选择。
export interface StageEditor {
  selectedID: string; // 当前编辑饰品。
  disabled: boolean; // 保存时冻结手势与键盘修改。
  onSelect: (id: string) => boolean; // 脏草稿切换需要确认时不启动拖动。
  onMove: (id: string, layout: AccessoryLayout) => void; // 仅更新本地草稿。
}

// 拖动保存起始坐标和画布尺寸，避免每个pointermove都读取布局。
interface DragState {
  id: string; // 拖动中的饰品。
  pointerID: number; // 防止第二个手指接管当前拖动。
  clientX: number; // 按下时屏幕横坐标。
  clientY: number; // 按下时屏幕纵坐标。
  width: number; // 正方形画布当前实际宽度。
  layout: AccessoryLayout; // 用于增量移动和手势取消恢复。
}

// 百分比保持桌面和手机显示一致，图片本身通过contain保持纵横比。
function layoutStyle(layout: AccessoryLayout, layer: number): CSSProperties {
  return { left: `${layout.x * 100}%`, top: `${layout.y * 100}%`, width: `${layout.size * 100}%`, height: `${layout.size * 100}%`, zIndex: layer };
}

// 显示顺序为背景、带角色参照的饰品层、固定特效和编辑操作层。
export function CharacterStage({ equipment, reduceMotion = false, editor }: {
  equipment: Equipment;
  reduceMotion?: boolean;
  editor?: StageEditor;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const staticMotion = useReducedMotion(reduceMotion);
  const order = accessoryOrder(equipment);
  const avatarKey = equipment.avatar ? portraitAssetKey(equipment.avatar) : equipment.base_avatar_key;
  const effectLayer = order.length + 1;
  const handleLayer = effectLayer + 1;
  // 捕获当前手指或鼠标，未完成草稿确认时不开始新手势。
  function start(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (!editor || editor.disabled || event.button !== 0 || drag.current || !editor.onSelect(id)) return;
    const width = stage.current?.getBoundingClientRect().width ?? 0;
    if (!width) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id, pointerID: event.pointerId, clientX: event.clientX, clientY: event.clientY, width, layout: accessoryLayout(equipment, id) };
  }
  // 屏幕位移换算为归一化坐标，不依赖设备像素密度。
  function move(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerID !== event.pointerId || editor?.disabled) return;
    editor?.onMove(active.id, clampLayout({ ...active.layout, x: active.layout.x + (event.clientX - active.clientX) / active.width, y: active.layout.y + (event.clientY - active.clientY) / active.width }));
  }
  // 取消手势还原按下时的位置，正常结束只释放指针捕获。
  function finish(event: PointerEvent<HTMLButtonElement>, cancelled: boolean) {
    const active = drag.current;
    if (!active || active.pointerID !== event.pointerId) return;
    if (cancelled) editor?.onMove(active.id, active.layout);
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <div className="shop-character-stage" ref={stage} data-editing={editor ? 'true' : undefined}>
    {equipment.background && <img className="shop-background-art" src={assetURL(portraitAssetKey(equipment.background))} alt={equipment.background.name_snapshot} draggable={false} />}
    {equipment.accessories.map((item) => <img key={item.id} className="shop-accessory-art" data-purchase-id={item.id} style={layoutStyle(accessoryLayout(equipment, item.id), order.indexOf(item.id) + 1)} src={assetURL(portraitAssetKey(item))} alt={item.name_snapshot} title={item.name_snapshot} draggable={false} />)}
    {isHumanAvatar(avatarKey)
      ? <HumanCharacterArtwork className="shop-avatar-art" style={{ zIndex: order.indexOf(avatarLayerID) + 1 }} baseAvatarKey={avatarKey} wearables={equipment.wearables} label={content.baseAvatarNames[avatarKey as keyof typeof content.baseAvatarNames]} />
      : <img className="shop-avatar-art" style={{ zIndex: order.indexOf(avatarLayerID) + 1 }} src={assetURL(avatarKey)} alt={equipment.avatar?.name_snapshot ?? content.defaultAvatar} draggable={false} />}
    {equipment.effects.map((item) => <img key={item.id} className="shop-effect-art" style={{ zIndex: effectLayer }} src={assetURL(portraitAssetKey(item), staticMotion)} alt={item.name_snapshot} draggable={false} />)}
    {editor && equipment.accessories.map((item) => <button
      type="button" key={item.id} className="shop-accessory-handle"
      style={layoutStyle(accessoryLayout(equipment, item.id), handleLayer + (editor.selectedID === item.id ? order.length : order.indexOf(item.id)))}
      aria-label={`${content.selectAccessory} ${item.name_snapshot}`} aria-pressed={editor.selectedID === item.id} disabled={editor.disabled}
      onClick={() => editor.onSelect(item.id)}
      onPointerDown={(event) => start(event, item.id)} onPointerMove={move}
      onPointerUp={(event) => finish(event, false)} onPointerCancel={(event) => finish(event, true)}
      onKeyDown={(event) => {
        const delta = { ArrowLeft: [-0.01, 0], ArrowRight: [0.01, 0], ArrowUp: [0, -0.01], ArrowDown: [0, 0.01] }[event.key];
        if (!delta || !editor.onSelect(item.id)) return;
        event.preventDefault();
        const layout = accessoryLayout(equipment, item.id);
        editor.onMove(item.id, clampLayout({ ...layout, x: layout.x + delta[0]!, y: layout.y + delta[1]! }));
      }}
    />)}
  </div>;
}
