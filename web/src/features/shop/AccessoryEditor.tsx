import { useState } from 'react';
import { Modal } from '../../components/Modal';
import type { Camp, Equipment, ShopClient } from './types';
import { CharacterStage } from './CharacterStage';
import { accessoryLayout, accessoryOrder, previewEquipment } from './accessory-layout';
import type { AccessoryLayout, AccessoryLayoutInput } from './accessory-layout';
import { shopError } from './helpers';
import { dispatchFeedback } from '../../feedback/feedback-events';
import content from './content.json';

// 单件编辑草稿，其他饰品仍以最近一次服务端结果为准。
interface AccessoryDraft {
  id: string; // 当前选中的永久饰品订单。
  layout: AccessoryLayout; // 当前单件的位置、大小和角度。
  order: string[]; // 含角色参照的本地预览顺序。
}

// 从保存状态建立草稿，取消操作使用同一个入口恢复。
function draftFor(equipment: Equipment, id: string): AccessoryDraft {
  return { id, layout: accessoryLayout(equipment, id), order: accessoryOrder(equipment) };
}

// 保存绝对位置和邻接意图，重试不会再次执行一次“向上移动”。
function layoutInput(draft: AccessoryDraft): AccessoryLayoutInput {
  return { x: draft.layout.x, y: draft.layout.y, size: draft.layout.size, rotation: draft.layout.rotation, before_id: draft.order[draft.order.indexOf(draft.id) + 1] ?? null };
}

// 编辑只保存一个饰品，切换和关闭时显式处理尚未保存的草稿。
export function AccessoryEditor({ equipment, displayName, reduceMotion = false, client, onSaved, onClose }: {
  equipment: Equipment;
  displayName: string;
  reduceMotion?: boolean;
  client: ShopClient;
  onSaved: (equipment: Equipment) => void;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState(equipment);
  // 入口仅在至少装备一件饰品时可用；后续卸下状态保留现有草稿。
  const [draft, setDraft] = useState(() => draftFor(equipment, equipment.accessories[0]!.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [highlightCharacter, setHighlightCharacter] = useState(false);
  const [priorityID, setPriorityID] = useState<string | null>(null); // 下拉框优先权仅持续到下一次有效画布操作。
  const [pendingAction, setPendingAction] = useState<{ kind: 'close' } | { kind: 'select'; id: string; prioritize: boolean } | null>(null);
  const available = saved.accessories.some((item) => item.id === draft.id);
  const dirty = available && JSON.stringify(layoutInput(draft)) !== JSON.stringify(layoutInput(draftFor(saved, draft.id)));
  const preview = available ? previewEquipment(saved, draft.id, draft.layout, draft.order) : saved;
  const index = draft.order.indexOf(draft.id);
  // 切换前先处理当前草稿，避免通过图层点击丢失尚未保存的修改。
  function select(id: string, prioritize = false): boolean {
    if (id === draft.id) {
      if (prioritize) setPriorityID(id);
      return true;
    }
    if (dirty) {
      setPendingAction({ kind: 'select', id, prioritize });
      return false;
    }
    setDraft(draftFor(saved, id));
    setPriorityID(prioritize ? id : null);
    setError(null);
    setMessage('');
    return true;
  }
  // 原生对话框关闭和Escape共用未保存检查。
  function close() {
    if (dirty) setPendingAction({ kind: 'close' });
    else onClose();
  }
  // 仅在用户明确放弃后执行先前请求的关闭或切换。
  function discard() {
    if (pendingAction?.kind === 'close') onClose();
    else if (pendingAction?.kind === 'select') {
      setDraft(draftFor(saved, pendingAction.id));
      setPriorityID(pendingAction.prioritize ? pendingAction.id : null);
      setError(null);
      setMessage('');
    }
    setPendingAction(null);
  }
  // 草稿按层移动包含角色参照，实际保存使用稳定邻接目标。
  function moveLayer(target: number) {
    setDraft((current) => {
      const order = current.order.filter((id) => id !== current.id);
      order.splice(target, 0, current.id);
      return { ...current, order };
    });
    setMessage('');
  }
  // 单件布局与层级一次提交，失败保留原草稿供重试。
  async function save() {
    setBusy(true);
    setHighlightCharacter(false);
    setError(null);
    setMessage('');
    try {
      const result = await client.request<Equipment>(`/equipment/accessories/${draft.id}/layout`, { method: 'PATCH', body: layoutInput(draft) });
      setSaved(result);
      setDraft(draftFor(result, draft.id));
      setMessage(content.equipmentSaved);
      setHighlightCharacter(true);
      dispatchFeedback('equip');
      onSaved(result);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  // 从正式营地读取恢复并发状态，刷新不会丢弃位置与大小草稿。
  async function reload() {
    setBusy(true);
    try {
      const { equipment: result } = await client.request<Camp>('/camp');
      const order = accessoryOrder(result);
      const nextID = layoutInput(draft).before_id;
      if (result.accessories.some((item) => item.id === draft.id)) {
        const nextOrder = order.filter((id) => id !== draft.id);
        // 目标已卸下时沿用服务端顺序，保留位置大小供重新确认。
        if (nextID === null || nextOrder.includes(nextID)) {
          nextOrder.splice(nextID === null ? nextOrder.length : nextOrder.indexOf(nextID), 0, draft.id);
          setDraft((current) => ({ ...current, order: nextOrder }));
        } else setDraft((current) => ({ ...current, order }));
        setMessage(content.reviewLayout);
      } else {
        // 饰品本身已被卸下，仍保留其草稿；重新选择其他饰品后方可保存。
        setMessage(content.accessoryNoLongerEquipped);
      }
      setSaved(result);
      onSaved(result);
      setError(null);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  if (pendingAction) return <Modal title={content.discardChanges} onClose={() => setPendingAction(null)}>
    <div className="button-row">
      <button type="button" onClick={() => setPendingAction(null)}>{content.keepEditing}</button>
      <button type="button" className="secondary" onClick={discard}>{content.discard}</button>
    </div>
  </Modal>;
  return <Modal title={content.editOutfit} onClose={close} closeDisabled={busy}>
    <div className="shop-outfit-editor">
      <section className={`shop-outfit-preview ${highlightCharacter ? 'feedback-pop' : ''}`} onAnimationEnd={(event) => { if (event.target === event.currentTarget) setHighlightCharacter(false); }} aria-label={`${displayName} ${content.character}`}>
      <CharacterStage equipment={preview} reduceMotion={reduceMotion} editor={{
        selectedID: draft.id,
        priorityID,
        disabled: busy,
        onSelect: select,
        onInteract: () => setPriorityID(null),
        onMove: (id, layout) => { setDraft((current) => ({ ...current, id, layout })); setMessage(''); },
      }} />
      </section>
      <section className="shop-outfit-settings" aria-label={content.editControls} tabIndex={0}>
      <label htmlFor="outfit-selected">{content.selectedAccessory}</label>
      <select id="outfit-selected" value={available ? draft.id : ''} disabled={busy}
        onPointerDown={(event) => { if (event.button === 0 && event.isPrimary !== false && available && !busy) setPriorityID(draft.id); }}
        onKeyDown={(event) => { if (available && !busy && ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(event.key)) setPriorityID(draft.id); }}
        onChange={(event) => select(event.target.value, true)}>
        {!available && <option value="" disabled>{content.selectAccessory}</option>}
        {saved.accessories.map((item) => <option key={item.id} value={item.id}>{item.name_snapshot}</option>)}
      </select>
      <fieldset className="shop-fieldset shop-outfit-controls" disabled={busy || !available}>
        <legend>{content.layers}</legend>
        <div className="shop-layout-actions" role="group" aria-label={content.layers}>
          <button type="button" className="secondary" disabled={index >= draft.order.length - 1} onClick={() => moveLayer(index + 1)}>{content.layerUp}</button>
          <button type="button" className="secondary" disabled={index <= 0} onClick={() => moveLayer(index - 1)}>{content.layerDown}</button>
          <button type="button" className="secondary" disabled={index >= draft.order.length - 1} onClick={() => moveLayer(draft.order.length - 1)}>{content.layerTop}</button>
          <button type="button" className="secondary" disabled={index <= 0} onClick={() => moveLayer(0)}>{content.layerBottom}</button>
        </div>
        <ol className="shop-layer-list" aria-label={content.layerOrder}>
          {[...draft.order].reverse().map((id) => <li key={id} aria-current={id === draft.id ? 'true' : undefined}>{id === 'avatar' ? content.avatarLayer : saved.accessories.find((item) => item.id === id)?.name_snapshot}</li>)}
        </ol>
      </fieldset>
      <div className="shop-layout-values">
        <span>{content.accessorySize} <output aria-label={content.accessorySize}>{Math.round(draft.layout.size * 100)}%</output></span>
        <span>{content.accessoryRotation} <output aria-label={content.accessoryRotation}>{Math.round(draft.layout.rotation)}°</output></span>
      </div>
      <p className="shop-layout-hint" id="outfit-layout-hint">{content.layoutHint}</p>
      {error !== null && <div role="alert"><p className="shop-error">{shopError(error)}</p><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>{content.reloadEquipment}</button></div>}
      {message && <p className={highlightCharacter ? 'feedback-success' : undefined} role="status">{message}</p>}
      <div className="button-row">
        <button type="button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? content.saving : content.save}</button>
        <button type="button" className="secondary" disabled={busy || !dirty} onClick={() => { setDraft(draftFor(saved, draft.id)); setError(null); setMessage(''); }}>{content.cancel}</button>
      </div>
      </section>
    </div>
  </Modal>;
}
