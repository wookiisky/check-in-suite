import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { ApiFailure } from '../../api/client';
import type { components } from '../../api/schema';
import { FieldError } from '../../components/FormFeedback';
import { Modal } from '../../components/Modal';
import { CharacterPreview3D } from '../character/CharacterPreview3D';
import { draftFromAppearance } from '../character/character3d-appearance';
import type { AppearanceDraft, CharacterLoadStatus } from '../character/character3d-appearance';
import { shopError, uncertainResult } from './helpers';
import { useReducedMotion } from './useReducedMotion';
import content from './appearance-content.json';
import './appearance-dialog.css';

type AppearanceState = components['schemas']['AppearanceState'];
type AppearanceSave = components['schemas']['AppearanceSave'];
type Wearable = components['schemas']['CharacterWearable'];
type AppearanceClient = Pick<ApiClient, 'request'>;

// 未确认写入在同一客户端的弹窗重开后继续核对，不把关闭误当成撤销。
interface PendingAppearance {
  snapshot: AppearanceState; // 发出原请求时使用的目录与版本。
  input: AppearanceSave; // 完整原请求，重试时不改写预期版本。
}
const pendingAppearances = new WeakMap<AppearanceClient, PendingAppearance>();
const slots = [
  { slot: 'hair', field: 'hair_purchase_id' },
  { slot: 'upper', field: 'upper_purchase_id' },
  { slot: 'lower', field: 'lower_purchase_id' },
  { slot: 'shoes', field: 'shoes_purchase_id' },
] as const;
type Slot = typeof slots[number]['slot'];

// 选择字段的逐项比较不依赖 JSON 键顺序，也不混入目录或版本字段。
function sameDraft(first: AppearanceDraft, second: AppearanceDraft) {
  return first.character_key === second.character_key && slots.every(({ field }) => first[field] === second[field]);
}

// 结果核对比较实际选择，不要求“本请求回执”这一接口并未提供的能力。
function draftFromInput(input: AppearanceSave): AppearanceDraft {
  return { character_key: input.character_key, hair_purchase_id: input.hair_purchase_id, upper_purchase_id: input.upper_purchase_id, lower_purchase_id: input.lower_purchase_id, shoes_purchase_id: input.shoes_purchase_id };
}

// 名称来自定义，实例选择保留购买身份，不根据名称或资源前缀推断部位。
function partName(snapshot: AppearanceState, slot: Slot): string {
  const character = snapshot.characters.find((candidate) => candidate.character_key === snapshot.character_key);
  const field = slots.find((candidate) => candidate.slot === slot)!.field;
  const id = snapshot[field];
  const key = id === null ? character?.defaults[slot] : snapshot.inventory.find((item) => item.purchase_id === id)?.wearable_key;
  return snapshot.wearables.find((item) => item.wearable_key === key)?.name ?? content.unavailablePart;
}

// 弹窗只写整套外观；共享层由 onSaved 发布确认结果，草稿始终留在本组件。
export function AppearanceDialog({ client, onClose, onSaved, reduceMotion = false }: {
  client: AppearanceClient;
  onClose: () => void;
  onSaved: (snapshot: AppearanceState) => void;
  reduceMotion?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<AppearanceState | null>(null);
  const [draft, setDraft] = useState<AppearanceDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<AppearanceState | null>(null);
  const [pending, setPending] = useState<PendingAppearance | null>(null);
  const [retryOriginal, setRetryOriginal] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<CharacterLoadStatus>({ phase: 'loading' });
  const reduced = useReducedMotion(reduceMotion);
  const generation = useRef(0); // 所有读取共用代次，迟到响应不能覆盖新读取。
  const readController = useRef<AbortController | null>(null); // 只取消 GET，不把取消误作写入回滚。
  const mounted = useRef(true); // 卸载后不发布结果到另一个编辑会话。
  const writing = useRef(false); // React 提交前也拒绝同一次双击提交。
  const callback = useRef(onSaved); callback.current = onSaved;

  // 保存响应直接成为新基线，模型状态稍后失败也不能改变保存事实。
  const acceptSaved = useCallback((next: AppearanceState, recovered = false) => {
    pendingAppearances.delete(client);
    setSnapshot(next); setDraft(draftFromAppearance(next)); setPending(null); setRetryOriginal(false);
    setConflict(false); setLatest(null); setError(null); setSaved(true); setConfirmed(recovered);
    callback.current(next);
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); readController.current = controller;
    const request = ++generation.current;
    const original = pendingAppearances.get(client);
    setLoading(true); setError(null); setSnapshot(null); setDraft(null);
    setSaving(false); setChecking(false); writing.current = false;
    setPending(null); setConflict(false); setLatest(null); setSaved(false); setConfirmed(false);
    void client.request<AppearanceState>('/appearance', { signal: controller.signal }).then((next) => {
      if (controller.signal.aborted || generation.current !== request) return;
      if (!original) { setSnapshot(next); setDraft(draftFromAppearance(next)); return; }
      if (next.version > original.input.expected_version && sameDraft(draftFromAppearance(next), draftFromInput(original.input))) { acceptSaved(next, true); return; }
      setSnapshot(original.snapshot); setDraft(draftFromInput(original.input));
      if (next.version > original.input.expected_version) {
        pendingAppearances.delete(client); setPending(null); setConflict(true); setLatest(next);
      } else { setPending(original); setRetryOriginal(true); }
    }).catch((reason) => { if (!controller.signal.aborted && generation.current === request) setError(reason); })
      .finally(() => { if (!controller.signal.aborted && generation.current === request) setLoading(false); });
    return () => { mounted.current = false; generation.current += 1; controller.abort(); readController.current?.abort(); };
  }, [client, attempt, acceptSaved]);

  const dirty = Boolean(snapshot && draft && !sameDraft(draftFromAppearance(snapshot), draft));
  const busy = saving || checking;
  const character = snapshot?.characters.find((item) => item.character_key === draft?.character_key);

  // 关闭只处理本地草稿；不取消已经提交的写请求，也不误报其结果。
  function close() {
    if (busy) return;
    if (dirty || pending) { setDiscarding(true); return; }
    onClose();
  }

  // 每次新选择只改草稿，仍允许模型加载中继续选择下一套。
  function choose(field: typeof slots[number]['field'], purchaseID: string | null) {
    if (busy || pending) return;
    setDraft((current) => current ? { ...current, [field]: purchaseID } : current);
    setSaved(false); setConfirmed(false); setError(null);
  }

  // 一次请求提交所有部位，未知结果重发仍使用原预期版本。
  async function save() {
    if (!snapshot || !draft || writing.current || checking || conflict || pending && !retryOriginal) return;
    const command = pending ?? { snapshot, input: { expected_version: snapshot.version, ...draft } };
    pendingAppearances.set(client, command); setPending(command); setRetryOriginal(false);
    writing.current = true; setSaving(true); setError(null); setSaved(false); setConfirmed(false);
    const request = ++generation.current; readController.current?.abort();
    let response: AppearanceState;
    try { response = await client.request<AppearanceState>('/appearance', { method: 'PUT', body: command.input }); }
    catch (reason) {
      if (!mounted.current || request !== generation.current) return;
      setError(reason);
      if (!uncertainResult(reason)) {
        pendingAppearances.delete(client); setPending(null);
        if (reason instanceof ApiFailure && reason.detail.code === 'VERSION_CONFLICT') setConflict(true);
      }
      return;
    } finally { if (mounted.current && request === generation.current) { writing.current = false; setSaving(false); } }
    if (mounted.current && request === generation.current) acceptSaved(response);
  }

  // 读取不会自动覆盖草稿；确认服务器已保存目标选择时才发布成功。
  async function readLatest() {
    if (busy) return;
    const controller = new AbortController(); readController.current?.abort(); readController.current = controller;
    const request = ++generation.current;
    setChecking(true); setError(null);
    try {
      const next = await client.request<AppearanceState>('/appearance', { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted || request !== generation.current) return;
      if (pending && next.version > pending.input.expected_version && sameDraft(draftFromAppearance(next), draftFromInput(pending.input))) { acceptSaved(next, true); return; }
      if (pending && next.version === pending.input.expected_version) { setRetryOriginal(true); return; }
      pendingAppearances.delete(client); setPending(null); setConflict(true); setLatest(next);
    } catch (reason) { if (mounted.current && !controller.signal.aborted && request === generation.current) setError(reason); }
    finally { if (mounted.current && !controller.signal.aborted && request === generation.current) setChecking(false); }
  }

  // 用户明确核对后才采用当前版本；保留草稿与恢复服务器外观分别提供。
  function useCurrent(keepDraft: boolean) {
    if (!latest || busy) return;
    setSnapshot(latest); if (!keepDraft) setDraft(draftFromAppearance(latest));
    setConflict(false); setLatest(null); setError(null); setSaved(false); setConfirmed(false);
  }

  if (discarding) return <Modal title={content.discardTitle} onClose={() => setDiscarding(false)}>
    <p>{pending ? content.pendingCloseWarning : content.discardWarning}</p>
    <div className="button-row"><button onClick={() => setDiscarding(false)}>{content.keepEditing}</button><button className="secondary" onClick={onClose}>{pending ? content.closePending : content.discard}</button></div>
  </Modal>;

  return <Modal title={content.title} onClose={close} closeDisabled={busy}>
    <div className="appearance-dialog">
      {loading && <p role="status">{content.loading}</p>}
      {error !== null && <p className="appearance-error" role="alert">{shopError(error)}</p>}
      {!snapshot && !loading && error !== null && <button onClick={() => setAttempt((value) => value + 1)}>{content.readRetry}</button>}
      {snapshot && draft && <>
        <div className="appearance-layout">
          <div className="appearance-preview"><CharacterPreview3D snapshot={snapshot} draft={draft} paused={reduced} onStatus={setPreview} label={content.previewLabel} /></div>
          <div className="appearance-slots">
            {!character && <p role="alert">{content.unavailableCharacter}</p>}
            {slots.map(({ slot, field }) => {
              const defaultWearable = snapshot.wearables.find((item) => item.wearable_key === character?.defaults[slot]);
              const owned = snapshot.inventory.flatMap((item) => {
                const wearable = snapshot.wearables.find((candidate) => candidate.wearable_key === item.wearable_key);
                return wearable && wearable.slot === slot && wearable.character_key === character?.character_key && wearable.rig_key === character.rig_key ? [{ item, wearable }] : [];
              });
              const instances = new Map<string, number>();
              return <fieldset key={slot} disabled={busy || Boolean(pending) || !character}>
                <legend>{content.slots[slot]}</legend>
                <div className="appearance-options">
                  {defaultWearable && <AppearanceOption name={content.defaultOption.replace('{name}', defaultWearable.name)} wearable={defaultWearable} selected={draft[field] === null} group={field} onChoose={() => choose(field, null)} />}
                  {owned.map(({ item, wearable }) => {
                    const count = (instances.get(wearable.wearable_key) ?? 0) + 1; instances.set(wearable.wearable_key, count);
                    const name = count === 1 ? wearable.name : content.additionalInstance.replace('{name}', wearable.name).replace('{number}', String(count));
                    return <AppearanceOption key={item.purchase_id} name={name} wearable={wearable} selected={draft[field] === item.purchase_id} group={field} onChoose={() => choose(field, item.purchase_id)} />;
                  })}
                </div>
                {!owned.length && <p className="appearance-hint">{content.emptyOwned}</p>}
                <FieldError error={error} field={field} />
              </fieldset>;
            })}
          </div>
        </div>
        {preview.phase === 'loading' && <p role="status">{content.previewLoading}</p>}
        {preview.phase === 'error' && <p className="appearance-error" role="alert">{saved ? content.savedModelFailed : content.previewFailed}</p>}
        {saved && preview.phase !== 'error' && <p className="feedback-success" role="status">{confirmed ? content.confirmed : content.saved}</p>}
        {conflict && <div className="appearance-recovery"><p role="alert">{content.conflict}</p>{!latest && <button disabled={busy} onClick={() => void readLatest()}>{checking ? content.checking : content.readLatest}</button>}</div>}
        {pending && !saving && <div className="appearance-recovery"><p role="alert">{retryOriginal ? content.notConfirmed : content.uncertain}</p><button disabled={busy} onClick={() => void readLatest()}>{checking ? content.checking : content.checkResult}</button></div>}
        {latest && <section className="appearance-recovery" aria-label={content.latestTitle}>
          <h3>{content.latestTitle}</h3><dl>{slots.map(({ slot }) => <div key={slot}><dt>{content.slots[slot]}</dt><dd>{partName(latest, slot)}</dd></div>)}</dl>
          <div className="button-row"><button disabled={busy} onClick={() => useCurrent(true)}>{content.keepDraft}</button><button className="secondary" disabled={busy} onClick={() => useCurrent(false)}>{content.useLatest}</button></div>
        </section>}
        <div className="appearance-actions"><button disabled={busy || conflict || !character || !dirty || preview.phase !== 'ready' || Boolean(pending && !retryOriginal)} onClick={() => void save()}>{saving ? content.saving : pending ? content.retryOriginal : content.save}</button><button className="secondary" disabled={busy} onClick={close}>{content.cancel}</button></div>
      </>}
    </div>
  </Modal>;
}

// 预览图只是目录缩略图；人物 Canvas 在旁边统一创建，不为每张卡另建。
function AppearanceOption({ name, wearable, selected, group, onChoose }: { name: string; wearable: Wearable; selected: boolean; group: string; onChoose: () => void }) {
  return <label className={`appearance-option ${selected ? 'appearance-selected' : ''}`}><input type="radio" name={group} aria-label={name} checked={selected} onChange={onChoose} /><img src={wearable.thumbnail_url} alt="" /><span>{name}</span></label>;
}
