import { useEffect, useRef } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
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
  priorityID: string | null; // 下拉框授予一次操作优先权的饰品。
  disabled: boolean; // 保存时冻结手势与键盘修改。
  onSelect: (id: string) => boolean; // 脏草稿切换需要确认时不启动拖动。
  onInteract: () => void; // 有效画布操作开始后消耗下拉框优先权。
  onMove: (id: string, layout: AccessoryLayout) => void; // 仅更新本地草稿。
}

// 四角以素材自身坐标表示，旋转后仍沿对应的对角线缩放。
const resizeCorners = { nw: [-1, -1], ne: [1, -1], sw: [-1, 1], se: [1, 1] } as const;
type ResizeCorner = keyof typeof resizeCorners;
type TransformMode = 'move' | 'resize' | 'rotate';

// 所有手势从按下时的完整布局计算，约束不会累计改变原尺寸。
interface DragState {
  id: string; // 拖动中的饰品。
  pointerID: number; // 防止第二个手指接管当前拖动。
  clientX: number; // 按下时屏幕横坐标。
  clientY: number; // 按下时屏幕纵坐标。
  width: number; // 正方形画布当前实际宽度。
  centerX: number; // 素材旋转中心的屏幕横坐标。
  centerY: number; // 素材旋转中心的屏幕纵坐标。
  mode: TransformMode; // 当前移动、缩放或旋转手势。
  corner: ResizeCorner; // 缩放所用的角点，其余模式忽略。
  element: HTMLButtonElement; // 捕获指针的操作目标。
  layout: AccessoryLayout; // 用于增量移动和手势取消恢复。
}

// 百分比保持桌面和手机显示一致，图片本身通过contain保持纵横比。
function layoutStyle(layout: AccessoryLayout, layer: number): CSSProperties {
  return { left: `${layout.x * 100}%`, top: `${layout.y * 100}%`, width: `${layout.size * 100}%`, height: `${layout.size * 100}%`, transform: `translate(-50%, -50%) rotate(${layout.rotation}deg)`, zIndex: layer };
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
  const selected = editor && equipment.accessories.find((item) => item.id === editor.selectedID);
  // 保存或卸载时结束指针捕获，迟到的事件不再改变已提交的草稿。
  useEffect(() => {
    if (!editor?.disabled) return;
    releaseDrag();
  }, [editor?.disabled]);
  useEffect(() => () => releaseDrag(), []);
  // 先清理状态再释放捕获，正常结束不能被lostpointercapture当作取消。
  function releaseDrag() {
    const active = drag.current;
    drag.current = null;
    if (active?.element.hasPointerCapture(active.pointerID)) active.element.releasePointerCapture(active.pointerID);
  }
  // 捕获当前手指或鼠标，未完成草稿确认时不开始新手势。
  function start(event: PointerEvent<HTMLButtonElement>, id: string, mode: TransformMode = 'move', corner: ResizeCorner = 'se') {
    if (!editor || editor.disabled || event.button !== 0 || event.isPrimary === false || drag.current || !editor.onSelect(id)) return;
    const bounds = stage.current?.getBoundingClientRect();
    if (!bounds?.width) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const layout = accessoryLayout(equipment, id);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id, pointerID: event.pointerId, clientX: event.clientX, clientY: event.clientY, width: bounds.width, centerX: bounds.left + layout.x * bounds.width, centerY: bounds.top + layout.y * bounds.width, layout, mode, corner, element: event.currentTarget };
    editor.onInteract();
  }
  // 屏幕位移换算为归一化坐标，不依赖设备像素密度。
  function move(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerID !== event.pointerId || editor?.disabled) return;
    const dx = (event.clientX - active.clientX) / active.width;
    const dy = (event.clientY - active.clientY) / active.width;
    let layout = active.layout;
    if (active.mode === 'move') layout = { ...layout, x: layout.x + dx, y: layout.y + dy };
    else if (active.mode === 'resize') {
      const radians = layout.rotation * Math.PI / 180;
      const [sx, sy] = resizeCorners[active.corner];
      const localX = dx * Math.cos(radians) + dy * Math.sin(radians);
      const localY = -dx * Math.sin(radians) + dy * Math.cos(radians);
      layout = { ...layout, size: layout.size + sx * localX + sy * localY };
    } else {
      const initial = Math.atan2(active.clientY - active.centerY, active.clientX - active.centerX);
      const current = Math.atan2(event.clientY - active.centerY, event.clientX - active.centerX);
      layout = { ...layout, rotation: layout.rotation + (current - initial) * 180 / Math.PI };
    }
    editor?.onMove(active.id, clampLayout(layout));
  }
  // 取消手势还原按下时的位置，正常结束只释放指针捕获。
  function finish(event: PointerEvent<HTMLButtonElement>, cancelled: boolean) {
    const active = drag.current;
    if (!active || active.pointerID !== event.pointerId) return;
    if (cancelled && !editor?.disabled) editor?.onMove(active.id, active.layout);
    releaseDrag();
  }
  // 每种画布操作都保留键盘入口，Home和End提供缩放与角度的基准。
  function keyTransform(event: KeyboardEvent<HTMLButtonElement>, id: string, mode: TransformMode) {
    if (!editor || editor.disabled || drag.current) return;
    const delta = { ArrowLeft: [-0.01, 0], ArrowRight: [0.01, 0], ArrowUp: [0, -0.01], ArrowDown: [0, 0.01] }[event.key];
    const reset = mode !== 'move' && event.key === 'Home';
    const maximum = mode === 'resize' && event.key === 'End';
    if ((!delta && !reset && !maximum) || !editor.onSelect(id)) return;
    event.preventDefault();
    editor.onInteract();
    let layout = accessoryLayout(equipment, id);
    if (mode === 'move' && delta) layout = { ...layout, x: layout.x + delta[0]!, y: layout.y + delta[1]! };
    else if (mode === 'resize') layout = { ...layout, size: reset ? 0.05 : maximum ? 1 : layout.size + delta![0]! - delta![1]! };
    else layout = { ...layout, rotation: reset ? 0 : layout.rotation + (delta![0]! - delta![1]!) * 100 };
    editor.onMove(id, clampLayout(layout));
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
      style={layoutStyle(accessoryLayout(equipment, item.id), handleLayer + (editor.priorityID === item.id ? order.length : order.indexOf(item.id)))}
      aria-label={`${content.selectAccessory} ${item.name_snapshot}`} aria-pressed={editor.selectedID === item.id} disabled={editor.disabled}
      // 指针已在按下时选中；忽略随后生成的click，防止优先权消耗后再次切换。
      onClick={(event) => { if (event.detail === 0 && !editor.disabled && !drag.current && editor.onSelect(item.id)) editor.onInteract(); }}
      onPointerDown={(event) => start(event, item.id)} onPointerMove={move}
      onPointerUp={(event) => finish(event, false)} onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={(event) => finish(event, true)}
      aria-describedby="outfit-layout-hint"
      onKeyDown={(event) => keyTransform(event, item.id, 'move')}
    />)}
    {editor && selected && <div className="shop-accessory-selection" style={layoutStyle(accessoryLayout(equipment, selected.id), handleLayer + order.length + 1)}>
      {(Object.keys(resizeCorners) as ResizeCorner[]).map((corner) => <button
        type="button" key={corner} className="shop-accessory-handle shop-accessory-transform-handle"
        data-transform="resize" data-corner={corner} disabled={editor.disabled}
        aria-label={`${content.resizeAccessory} ${selected.name_snapshot}`} aria-describedby="outfit-layout-hint"
        onPointerDown={(event) => start(event, selected.id, 'resize', corner)} onPointerMove={move}
        onPointerUp={(event) => finish(event, false)} onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => finish(event, true)}
        onKeyDown={(event) => keyTransform(event, selected.id, 'resize')}
      />)}
      <button type="button" className="shop-accessory-handle shop-accessory-transform-handle"
        data-transform="rotate" disabled={editor.disabled}
        aria-label={`${content.rotateAccessory} ${selected.name_snapshot}`} aria-describedby="outfit-layout-hint"
        onPointerDown={(event) => start(event, selected.id, 'rotate')} onPointerMove={move}
        onPointerUp={(event) => finish(event, false)} onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => finish(event, true)}
        onKeyDown={(event) => keyTransform(event, selected.id, 'rotate')}
      />
    </div>}
  </div>;
}
