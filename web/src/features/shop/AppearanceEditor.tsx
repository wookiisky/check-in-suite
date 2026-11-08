import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref } from 'react';
import type { ApiClient } from '../../api/client';
import { ApiFailure } from '../../api/client';
import type { components } from '../../api/schema';
import { FieldError } from '../../components/FormFeedback';
import { Modal } from '../../components/Modal';
import { NumberedPagination } from '../../components/NumberedPagination';
import { ViewTabs } from '../../components/ViewTabs';
import { CharacterPreview3D } from '../character/CharacterPreview3D';
import { draftFromAppearance, freeCharacterDefinitions, wearableFitsCharacter } from '../character/character3d-appearance';
import type { AppearanceDraft, CharacterLoadStatus } from '../character/character3d-appearance';
import { shopError, uncertainResult } from './helpers';
import { useReducedMotion } from './useReducedMotion';
import content from './appearance-content.json';
import './appearance-dialog.css';

type AppearanceState = components['schemas']['AppearanceState'];
type AppearanceSave = components['schemas']['AppearanceSave'];
type Wearable = components['schemas']['CharacterWearable'];
type AppearanceClient = Pick<ApiClient, 'request'>;

// 未确认写入在同一客户端重新进入后继续核对。
interface PendingAppearance {
  snapshot: AppearanceState; // 发出原请求时使用的目录与版本。
  input: AppearanceSave; // 完整原请求，重试时不改写预期版本。
}
const pendingByClient = new WeakMap<AppearanceClient, Map<number | undefined, PendingAppearance>>();

// 同一客户端可以重新登录，原保存请求只属于发出请求的账号。
function pendingAppearances(client: AppearanceClient) {
  const current = pendingByClient.get(client);
  if (current) return current;
  const next = new Map<number | undefined, PendingAppearance>();
  pendingByClient.set(client, next);
  return next;
}
const slots = [
  { slot: 'face', field: 'face_purchase_id', freeField: 'face_free_wearable_key' },
  { slot: 'head', field: 'head_purchase_id', freeField: 'head_free_wearable_key' },
  { slot: 'upper', field: 'upper_purchase_id', freeField: 'upper_free_wearable_key' },
  { slot: 'lower', field: 'lower_purchase_id', freeField: 'lower_free_wearable_key' },
  { slot: 'shoes', field: 'shoes_purchase_id', freeField: 'shoes_free_wearable_key' },
  { slot: 'back', field: 'back_purchase_id', freeField: 'back_free_wearable_key' },
] as const;
type Slot = typeof slots[number]['slot'];
const pageSize = 12;
const categoryTabs = [{ id: '', label: content.allCategories }, { id: 'body', label: content.characterTitle },
  ...slots.map(({ slot }) => ({ id: slot, label: content.slots[slot] }))];

/** 每个部位的选项保留订单或目录身份。 */
interface EditorOption {
  key: string; // 当前部位内稳定的 React 标识。
  name: string; // 展示名，重复实例包含序号。
  thumbnailUrl: string | undefined; // 身体可能没有缩略图。
  value: string; // 原生选择控件的值。
  selected: boolean; // 对应当前草稿的选择。
  onChoose: () => void; // 应用到草稿的操作。
}

/** 分类可独立浏览，也可在全部分类中连续分页。 */
interface EditorCategory {
  key: string; // 二级分类标识。
  field: string; // 后端校验字段，也是 radio 组名。
  label: string; // 分类显示名。
  disabled: boolean; // 当前是否可编辑。
  emptyOwned: boolean; // 素材验证入口用来提示只有默认款。
  options: EditorOption[]; // 按该类别的既定顺序展示。
}

/** App 将导航、品牌和登出统一交给编辑器确认。 */
export type AppearanceLeaveGuard = (leave: () => void) => void;

/** 页面与素材验证入口共用的编辑器依赖。 */
export interface AppearanceEditorProps {
  client: AppearanceClient; // 外观读写客户端。
  accountID?: number; // 复用客户端时隔离未确认写入。
  onSaved: (snapshot: AppearanceState) => void; // 发布确认成功的完整快照。
  reduceMotion?: boolean; // 账户的减少动效偏好。
}

// 选择字段的逐项比较不依赖 JSON 键顺序，也不混入目录或版本字段。
function sameDraft(first: AppearanceDraft, second: AppearanceDraft) {
  return first.character_key === second.character_key && slots.every(({ field, freeField }) => first[field] === second[field] && (first[freeField] ?? null) === (second[freeField] ?? null));
}

// 结果核对比较实际选择，不要求“本请求回执”这一接口并未提供的能力。
function draftFromInput(input: AppearanceSave): AppearanceDraft {
  return { character_key: input.character_key, face_purchase_id: input.face_purchase_id, back_purchase_id: input.back_purchase_id, head_purchase_id: input.head_purchase_id, upper_purchase_id: input.upper_purchase_id, lower_purchase_id: input.lower_purchase_id, shoes_purchase_id: input.shoes_purchase_id, ...Object.fromEntries(slots.flatMap(({ freeField }) => input[freeField] ? [[freeField, input[freeField]]] : [])) };
}

// 名称来自定义，实例选择保留购买身份，不根据名称或资源前缀推断部位。
function partName(snapshot: AppearanceState, slot: Slot): string {
  const character = snapshot.characters.find((candidate) => candidate.character_key === snapshot.character_key);
  const { field, freeField } = slots.find((candidate) => candidate.slot === slot)!;
  const id = snapshot[field];
  const key = id === null ? snapshot[freeField] ?? character?.defaults[slot] : snapshot.inventory.find((item) => item.purchase_id === id && snapshot.wearables.find((definition) => definition.wearable_key === item.wearable_key)?.slot === slot)?.wearable_key;
  return snapshot.wearables.find((item) => item.wearable_key === key)?.name ?? content.unavailablePart;
}

// 编辑器只写整套外观；共享层由 onSaved 发布确认结果，草稿始终留在本组件。
export function AppearanceEditor({ client, accountID, onClose, onSaved, reduceMotion = false, leaveGuardRef }: AppearanceEditorProps & (
  { onClose: () => void; leaveGuardRef?: never } | { onClose?: never; leaveGuardRef: Ref<AppearanceLeaveGuard> }
)) {
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
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [saved, setSaved] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<CharacterLoadStatus>({ phase: 'loading' });
  const reduced = useReducedMotion(reduceMotion);
  const generation = useRef(0); // 所有读取共用代次，迟到响应不能覆盖新读取。
  const readController = useRef<AbortController | null>(null); // 只取消 GET，不把取消误作写入回滚。
  const mounted = useRef(true); // 卸载后不发布结果到另一个编辑会话。
  const writing = useRef(false); // React 提交前也拒绝同一次双击提交。
  const callback = useRef(onSaved); callback.current = onSaved;
  const pendingWrites = pendingAppearances(client);

  // 保存响应直接成为新基线，模型状态稍后失败也不能改变保存事实。
  const acceptSaved = useCallback((next: AppearanceState, recovered = false) => {
    pendingWrites.delete(accountID);
    setSnapshot(next); setDraft(draftFromAppearance(next)); setPending(null); setRetryOriginal(false);
    setConflict(false); setLatest(null); setError(null); setSaved(true); setConfirmed(recovered);
    callback.current(next);
  }, [accountID, pendingWrites]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); readController.current = controller;
    const request = ++generation.current;
    const original = pendingWrites.get(accountID);
    setLoading(true); setError(null); setSnapshot(null); setDraft(null);
    setSaving(false); setChecking(false); writing.current = false;
    setPending(null); setConflict(false); setLatest(null); setSaved(false); setConfirmed(false);
    void client.request<AppearanceState>('/appearance', { signal: controller.signal }).then((next) => {
      if (controller.signal.aborted || generation.current !== request) return;
      if (!original) { setSnapshot(next); setDraft(draftFromAppearance(next)); return; }
      if (next.version > original.input.expected_version && sameDraft(draftFromAppearance(next), draftFromInput(original.input))) { acceptSaved(next, true); return; }
      setSnapshot(original.snapshot); setDraft(draftFromInput(original.input));
      if (next.version > original.input.expected_version) {
        pendingWrites.delete(accountID); setPending(null); setConflict(true); setLatest(next);
      } else { setPending(original); setRetryOriginal(true); }
    }).catch((reason) => { if (!controller.signal.aborted && generation.current === request) setError(reason); })
      .finally(() => { if (!controller.signal.aborted && generation.current === request) setLoading(false); });
    return () => { mounted.current = false; generation.current += 1; controller.abort(); readController.current?.abort(); };
  }, [client, accountID, attempt, acceptSaved, pendingWrites]);

  const dirty = Boolean(snapshot && draft && !sameDraft(draftFromAppearance(snapshot), draft));
  const busy = saving || checking;
  const character = snapshot?.characters.find((item) => item.character_key === draft?.character_key);
  const ownedCharacters = new Set(snapshot?.character_inventory?.map((item) => item.character_key));
  const selectableCharacters = snapshot?.characters.filter((item) => item.character_key === (snapshot.default_character_key ?? snapshot.character_key) || ownedCharacters.has(item.character_key)) ?? [];

  // 离开只处理本地草稿；不取消已经提交的写请求，也不误报其结果。
  const requestLeave: AppearanceLeaveGuard = (leave) => {
    if (busy || writing.current) return;
    if (dirty || pending) { setLeaving(() => leave); return; }
    leave();
  };
  useImperativeHandle(leaveGuardRef, () => requestLeave);

  // 每次新选择只改草稿，仍允许模型加载中继续选择下一套。
  function choose(field: typeof slots[number]['field'], purchaseID: string | null) {
    if (busy || pending) return;
    const freeField = slots.find((item) => item.field === field)!.freeField;
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, [field]: purchaseID }; delete next[freeField]; return next;
    });
    setSaved(false); setConfirmed(false); setError(null);
  }

  // 已取得身体的基础部件用定义身份保存，不伪造订单，也不能与购买实例同时选择。
  function chooseFree(slot: typeof slots[number], wearableKey: string) {
    if (busy || pending) return;
    setDraft((current) => current ? { ...current, [slot.field]: null, [slot.freeField]: wearableKey } : current);
    setSaved(false); setConfirmed(false); setError(null);
  }

  // 换人物先展示其默认整套；已购买的共用服装仍可在各槽重新选择。
  function chooseCharacter(key: string) {
    if (busy || pending || !selectableCharacters.some((item) => item.character_key === key)) return;
    setDraft({ character_key: key, face_purchase_id: null, back_purchase_id: null, head_purchase_id: null, upper_purchase_id: null, lower_purchase_id: null, shoes_purchase_id: null });
    setSaved(false); setConfirmed(false); setError(null);
  }

  // 一次请求提交所有部位，未知结果重发仍使用原预期版本。
  async function save() {
    if (!snapshot || !draft || writing.current || checking || conflict || pending && !retryOriginal) return;
    const command = pending ?? { snapshot, input: { expected_version: snapshot.version, ...draft } };
    pendingWrites.set(accountID, command); setPending(command); setRetryOriginal(false);
    writing.current = true; setSaving(true); setError(null); setSaved(false); setConfirmed(false);
    const request = ++generation.current; readController.current?.abort();
    let response: AppearanceState;
    try { response = await client.request<AppearanceState>('/appearance', { method: 'PUT', body: command.input }); }
    catch (reason) {
      if (!mounted.current || request !== generation.current) return;
      setError(reason);
      if (!uncertainResult(reason)) {
        pendingWrites.delete(accountID); setPending(null);
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
      pendingWrites.delete(accountID); setPending(null); setConflict(true); setLatest(next);
    } catch (reason) { if (mounted.current && !controller.signal.aborted && request === generation.current) setError(reason); }
    finally { if (mounted.current && !controller.signal.aborted && request === generation.current) setChecking(false); }
  }

  // 用户明确核对后才采用当前版本；保留草稿与恢复服务器外观分别提供。
  function useCurrent(keepDraft: boolean) {
    if (!latest || busy) return;
    setSnapshot(latest); if (!keepDraft) setDraft(draftFromAppearance(latest));
    setConflict(false); setLatest(null); setError(null); setSaved(false); setConfirmed(false);
  }

  const disabled = busy || Boolean(pending);
  const categories: EditorCategory[] = [];
  if (snapshot && draft) {
    categories.push({
      key: 'body',
      field: 'character_key',
      label: content.characterTitle,
      disabled,
      emptyOwned: false,
      options: selectableCharacters.map((item) => ({
        key: item.character_key,
        name: item.name,
        thumbnailUrl: item.thumbnail_url,
        value: item.character_key,
        selected: draft.character_key === item.character_key,
        onChoose: () => chooseCharacter(item.character_key),
      })),
    });

    const wearablesByKey = new Map(snapshot.wearables.map((item) => [item.wearable_key, item]));
    const freeCharacters = freeCharacterDefinitions(snapshot);
    for (const configuration of slots) {
      const { slot, field, freeField } = configuration;
      const defaultWearable = wearablesByKey.get(character?.defaults[slot] ?? '');
      const freeKeys = new Set(freeCharacters.map((item) => item.defaults[slot]));
      const freeWearables = snapshot.wearables.filter((item) => freeKeys.has(item.wearable_key) && item !== defaultWearable && character && wearableFitsCharacter(item, character, snapshot.characters));
      const owned = snapshot.inventory.flatMap((item) => {
        const wearable = wearablesByKey.get(item.wearable_key);
        return wearable && character && wearable.slot === slot && wearableFitsCharacter(wearable, character, snapshot.characters) ? [{ item, wearable }] : [];
      });
      const instances = new Map<string, number>();
      const options: (EditorOption & { wearable: Wearable })[] = [
        ...(defaultWearable ? [{
          key: 'default',
          name: content.defaultOption.replace('{name}', defaultWearable.name),
          thumbnailUrl: defaultWearable.thumbnail_url,
          wearable: defaultWearable,
          value: '',
          selected: draft[field] === null && (!draft[freeField] || draft[freeField] === defaultWearable.wearable_key),
          onChoose: () => choose(field, null),
        }] : []),
        ...freeWearables.map((wearable) => ({
          key: wearable.wearable_key,
          name: content.initialFreeOption.replace('{name}', wearable.name),
          thumbnailUrl: wearable.thumbnail_url,
          wearable,
          value: wearable.wearable_key,
          selected: draft[field] === null && draft[freeField] === wearable.wearable_key,
          onChoose: () => chooseFree(configuration, wearable.wearable_key),
        })),
        ...owned.map(({ item, wearable }) => {
          const count = (instances.get(wearable.wearable_key) ?? 0) + 1;
          instances.set(wearable.wearable_key, count);
          const name = count === 1 ? wearable.name : content.additionalInstance.replace('{name}', wearable.name).replace('{number}', String(count));
          return {
            key: item.purchase_id,
            name,
            thumbnailUrl: wearable.thumbnail_url,
            wearable,
            value: item.purchase_id,
            selected: draft[field] === item.purchase_id,
            onChoose: () => choose(field, item.purchase_id),
          };
        }),
      ];
      // 形象按目录顺序排列，不随默认款或购买顺序移动。
      if (slot === 'face') {
        options.sort((first, second) => snapshot.wearables.indexOf(first.wearable) - snapshot.wearables.indexOf(second.wearable));
      }
      categories.push({ key: slot, field, label: content.slots[slot], disabled: disabled || !character, emptyOwned: !owned.length, options });
    }
  }
  const browsable = categories.filter((group) => !category || group.key === category);
  const matchingOptions = browsable.flatMap((group) => group.options);
  const totalPages = Math.max(1, Math.ceil(matchingOptions.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleOptions = new Set(matchingOptions.slice((currentPage - 1) * pageSize, currentPage * pageSize));
  const groups = onClose ? categories : browsable
    .map((group) => ({ ...group, options: group.options.filter((option) => visibleOptions.has(option)) }))
    .filter((group) => group.options.length > 0);

  const leaveConfirmation = leaving && <Modal title={content.discardTitle} onClose={() => setLeaving(null)}>
    <p>{pending ? content.pendingCloseWarning : content.discardWarning}</p>
    <div className="button-row">
      <button onClick={() => setLeaving(null)}>{content.keepEditing}</button>
      <button className="secondary" onClick={() => { setLeaving(null); leaving(); }}>{pending ? content.closePending : content.discard}</button>
    </div>
  </Modal>;
  if (onClose && leaveConfirmation) return leaveConfirmation;

  const categoryFields = <>
    {!character && <p role="alert">{content.unavailableCharacter}</p>}
    <div className="appearance-slots">
      {groups.map((group) => <fieldset key={group.key} disabled={group.disabled}>
        <legend>{group.label}</legend>
        <div className="appearance-options">
          {group.options.map(({ key, ...option }) => <AppearanceOption key={key} {...option} group={group.field} />)}
        </div>
        {onClose && group.emptyOwned && <p className="appearance-hint">{content.emptyOwned}</p>}
        <FieldError error={error} field={group.field} />
      </fieldset>)}
    </div>
  </>;

  const previewView = snapshot && draft && <div className="appearance-preview">
    <CharacterPreview3D snapshot={snapshot} draft={draft} paused={reduced} onStatus={setPreview} label={content.previewLabel} rotatable />
  </div>;
  const editor = <div className="appearance-dialog">
      {loading && <p role="status">{content.loading}</p>}
      {error !== null && <p className="appearance-error" role="alert">{shopError(error)}</p>}
      {!snapshot && !loading && error !== null && <button onClick={() => setAttempt((value) => value + 1)}>{content.readRetry}</button>}
      {snapshot && draft && <>
        <div className="appearance-layout">
          {onClose && previewView}
          {onClose ? categoryFields : <div className="appearance-catalog">
            <ViewTabs label={content.categoryLabel} items={categoryTabs} value={category}
              className="shop-category-tabs shop-category-details"
              onChange={(next) => { setCategory(next); setPage(1); }}>
              {groups.length ? categoryFields : <p>{content.emptyCategory}</p>}
              <NumberedPagination page={currentPage} totalPages={totalPages} onPageChange={setPage} />
            </ViewTabs>
          </div>}
          {!onClose && previewView}
        </div>
        {preview.phase === 'loading' && <p role="status">{content.previewLoading}</p>}
        {preview.phase === 'error' && <p className="appearance-error" role="alert">{saved ? content.savedModelFailed : content.previewFailed}</p>}
        {saved && preview.phase !== 'error' && <p className="feedback-success" role="status">{confirmed ? content.confirmed : content.saved}</p>}
        {conflict && <div className="appearance-recovery"><p role="alert">{content.conflict}</p>{!latest && <button disabled={busy} onClick={() => void readLatest()}>{checking ? content.checking : content.readLatest}</button>}</div>}
        {pending && !saving && <div className="appearance-recovery"><p role="alert">{retryOriginal ? content.notConfirmed : content.uncertain}</p><button disabled={busy} onClick={() => void readLatest()}>{checking ? content.checking : content.checkResult}</button></div>}
        {latest && <section className="appearance-recovery" aria-label={content.latestTitle}>
          <h3>{content.latestTitle}</h3><dl><div><dt>{content.characterTitle}</dt><dd>{latest.characters.find((item) => item.character_key === latest.character_key)?.name ?? content.unavailablePart}</dd></div>{slots.map(({ slot }) => <div key={slot}><dt>{content.slots[slot]}</dt><dd>{partName(latest, slot)}</dd></div>)}</dl>
          <div className="button-row"><button disabled={busy} onClick={() => useCurrent(true)}>{content.keepDraft}</button><button className="secondary" disabled={busy} onClick={() => useCurrent(false)}>{content.useLatest}</button></div>
        </section>}
        <div className="appearance-actions"><button disabled={busy || conflict || !character || !dirty || preview.phase !== 'ready' || Boolean(pending && !retryOriginal)} onClick={() => void save()}>{saving ? content.saving : pending ? content.retryOriginal : content.save}</button>{onClose && <button className="secondary" disabled={busy} onClick={() => requestLeave(onClose)}>{content.cancel}</button>}</div>
      </>}
    </div>;
  if (onClose) return <Modal title={content.title} onClose={() => requestLeave(onClose)} closeDisabled={busy}>{editor}</Modal>;
  return <section className="appearance-page panel">
    <h1>{content.pageTitle}</h1>
    {editor}
    {leaveConfirmation}
  </section>;
}

// 预览图只是目录缩略图；人物 Canvas 在旁边统一创建，不为每张卡另建。
function AppearanceOption({ name, thumbnailUrl, selected, group, value, onChoose }: Omit<EditorOption, 'key'> & { group: string }) {
  return <label className={`appearance-option ${selected ? 'appearance-selected' : ''}`}><input type="radio" name={group} value={value} aria-label={name} checked={selected} onChange={onChoose} />{thumbnailUrl && <img src={thumbnailUrl} alt="" loading="lazy" decoding="async" />}<span>{name}</span></label>;
}
