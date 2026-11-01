import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { ApiFailure } from '../../../api/client';
import type { ApiClient } from '../../../api/client';
import type { components } from '../../../api/schema';
import { houseForPlacements, layoutIssue } from './spatial-layout';
import type { SpatialIslandState, SpatialPlacement } from './spatial-ui-types';

type LayoutClient = Pick<ApiClient, 'request'>;
type LayoutRequest = components['schemas']['SpatialIslandSave'];

/** 草稿只保存布局和环境，不复制库存与目录。 */
interface SpatialDraft {
  placements: SpatialPlacement[]; // 编辑中的完整摆放。
  environment_key: string; // 环境与主屋独立。
}

/** 同客户端挂载共享编辑状态，未知请求不因页面卸载而丢失。 */
interface LayoutSnapshot {
  state: SpatialIslandState | null; // 最近确认的服务端快照。
  draft: SpatialDraft | null; // 待保存或待核对的草稿。
  loading: boolean; // 最新读取是否在途。
  saving: boolean; // 原始保存请求是否在途。
  error: unknown; // 最近一次实际失败。
  conflict: boolean; // 保存明确返回版本冲突。
  inventoryConflict: boolean; // 保存因实例已在其他场景占用而被明确拒绝。
  review: boolean; // 新版本与草稿需要用户核对。
  unknownSave: boolean; // 原请求是否可能仍在服务端提交。
  canRetryOriginal: boolean; // 已读回原版本，可显式重发原请求。
}

/** journal 持有原请求和读取代次，写请求完成后仍可恢复其结果。 */
interface LayoutJournal {
  sceneKey: string; // 读取、草稿与冻结请求始终属于同一个空间。
  snapshot: LayoutSnapshot; // 对订阅者稳定发布的状态。
  original: LayoutRequest | null; // 冻结的版本和完整保存值。
  read: AbortController | null; // 当前可取消的只读请求。
  generation: number; // 旧读取即使忽略取消也不能覆盖新结果。
  consumers: number; // 最后一处卸载才取消读取。
  listeners: Set<() => void>; // 同客户端的活动订阅者。
  subscribe: (listener: () => void) => () => void; // React 外部状态订阅。
  getSnapshot: () => LayoutSnapshot; // 返回已缓存快照。
}

const journals = new WeakMap<LayoutClient, Map<string, LayoutJournal>>();

// 同一客户端保留 journal，切换客户端后旧响应只更新旧 journal。
function journalFor(client: LayoutClient, sceneKey: string): LayoutJournal {
  let scenes = journals.get(client);
  if (!scenes) { scenes = new Map(); journals.set(client, scenes); }
  const existing = scenes.get(sceneKey);
  if (existing) return existing;
  const journal: LayoutJournal = {
    sceneKey,
    snapshot: { state: null, draft: null, loading: true, saving: false, error: null, conflict: false, inventoryConflict: false, review: false, unknownSave: false, canRetryOriginal: false },
    original: null, read: null, generation: 0, consumers: 0, listeners: new Set(),
    subscribe: (listener) => { journal.listeners.add(listener); return () => { journal.listeners.delete(listener); }; },
    getSnapshot: () => journal.snapshot,
  };
  scenes.set(sceneKey, journal);
  return journal;
}

// 发布只替换状态外壳，状态提示改变不会重建布局或草稿对象。
function publish(journal: LayoutJournal, update: Partial<LayoutSnapshot>) {
  journal.snapshot = { ...journal.snapshot, ...update };
  for (const listener of journal.listeners) listener();
}

// 比较实例布局值，忽略数组顺序、版本与新增库存。
function sameLayout(first: SpatialDraft, second: SpatialDraft) {
  if (first.environment_key !== second.environment_key || first.placements.length !== second.placements.length) return false;
  const byID = new Map(second.placements.map((placement) => [placement.instance_id, placement]));
  return first.placements.every((placement) => {
    const other = byID.get(placement.instance_id);
    return other && placement.item_key === other.item_key && placement.space === other.space && placement.x_cm === other.x_cm && placement.z_cm === other.z_cm && placement.rotation === other.rotation;
  });
}

// 取消读取并推进代次，不能让延迟响应回退已保存版本。
function cancelRead(journal: LayoutJournal) {
  journal.generation++;
  journal.read?.abort();
  journal.read = null;
}

// 读回只有版本推进且值一致才证明保存；原版本只能用于显式重发。
async function readJournal(client: LayoutClient, journal: LayoutJournal) {
  if (journal.snapshot.saving) return;
  cancelRead(journal);
  const generation = journal.generation;
  const controller = new AbortController();
  journal.read = controller;
  publish(journal, { loading: true, error: null, canRetryOriginal: false });
  try {
    const path = journal.sceneKey === 'seaside-v1' ? '/island/layout' : `/island/layout?scene_key=${encodeURIComponent(journal.sceneKey)}`;
    const next = await client.request<SpatialIslandState>(path, { signal: controller.signal });
    if (controller.signal.aborted || generation !== journal.generation) return;
    if (next.scene_key !== journal.sceneKey) throw new ApiFailure(502, { code: 'INVALID_RESPONSE', field_errors: {}, request_id: '' });
    const before = journal.snapshot;
    if (before.state && next.version < before.state.version) return;
    const original = journal.original;
    const update: Partial<LayoutSnapshot> = { state: next, conflict: false, inventoryConflict: false };
    if (before.unknownSave && original) {
      if (next.version <= original.expected_version) {
        update.canRetryOriginal = next.version === original.expected_version;
      } else {
        journal.original = null;
        update.unknownSave = false;
        if (original.scene_key === next.scene_key && sameLayout(original, next)) { update.draft = null; update.review = false; }
        else update.review = true;
      }
    } else if (before.draft) update.review = true;
    publish(journal, update);
  } catch (reason) {
    if (!controller.signal.aborted && generation === journal.generation) publish(journal, { error: reason });
  } finally {
    if (!controller.signal.aborted && generation === journal.generation) {
      journal.read = null;
      publish(journal, { loading: false });
    }
  }
}

// 写请求不随卸载取消；结果未知时保留冻结请求，等待读回或原样重发。
async function writeOriginal(client: LayoutClient, journal: LayoutJournal): Promise<boolean> {
  const original = journal.original;
  if (!original || journal.snapshot.saving) return false;
  cancelRead(journal);
  publish(journal, { saving: true, loading: false, error: null, canRetryOriginal: false });
  try {
    const next = await client.request<SpatialIslandState>('/island/layout', { method: 'PUT', body: structuredClone(original) });
    if (next.scene_key !== journal.sceneKey) throw new ApiFailure(502, { code: 'INVALID_RESPONSE', field_errors: {}, request_id: '' });
    journal.original = null;
    publish(journal, { state: next, draft: null, conflict: false, inventoryConflict: false, review: false, unknownSave: false });
    return true;
  } catch (reason) {
    const conflict = reason instanceof ApiFailure && reason.detail.code === 'VERSION_CONFLICT';
    const inventoryConflict = reason instanceof ApiFailure && reason.status === 400 && reason.detail.code === 'INVALID_REQUEST' && reason.detail.field_errors.placements === 'PLACED_IN_OTHER_SCENE';
    const unknownSave = !(reason instanceof ApiFailure) || reason.status === 0 || reason.status >= 500 || reason.detail.code === 'INVALID_RESPONSE';
    if (!unknownSave) journal.original = null;
    publish(journal, { error: reason, conflict, inventoryConflict, unknownSave });
    return false;
  } finally {
    publish(journal, { saving: false });
  }
}

// 保存失败及冲突都保留草稿；只有真实响应或可证明的读回才确认保存。
export function useSpatialLayout(client: LayoutClient, sceneKey = 'seaside-v1') {
  const journal = useMemo(() => journalFor(client, sceneKey), [client, sceneKey]);
  const snapshot = useSyncExternalStore(journal.subscribe, journal.getSnapshot, journal.getSnapshot);
  const { state, draft } = snapshot;
  const readLatest = useCallback(() => readJournal(client, journal), [client, journal]);
  useEffect(() => {
    journal.consumers++;
    void readLatest();
    return () => {
      journal.consumers--;
      if (journal.consumers === 0) { cancelRead(journal); publish(journal, { loading: false }); }
    };
  }, [journal, readLatest]);

  // 编辑基于当前确认快照，未知原请求不能被新编辑替换。
  function begin() {
    const before = journal.snapshot;
    if (!before.state || before.saving || before.unknownSave || before.draft) return;
    publish(journal, { draft: { placements: before.state.placements.map((placement) => ({ ...placement })), environment_key: before.state.environment_key }, error: null });
  }
  // 普通草稿可取消；原写入未确定时必须先恢复结果。
  function cancel(): boolean {
    if (journal.snapshot.saving || journal.snapshot.unknownSave) return false;
    journal.original = null;
    publish(journal, { draft: null, conflict: false, inventoryConflict: false, review: false, error: null, canRetryOriginal: false });
    return true;
  }
  // 未知保存和在途保存期间保持提交值不变。
  function setPlacements(placements: SpatialPlacement[]) {
    const before = journal.snapshot;
    if (before.draft && !before.saving && !before.unknownSave) publish(journal, { draft: { ...before.draft, placements } });
  }
  // 环境与完整布局共用同一个原请求。
  function setEnvironment(environment_key: string) {
    const before = journal.snapshot;
    if (before.draft && !before.saving && !before.unknownSave) publish(journal, { draft: { ...before.draft, environment_key } });
  }
  // 普通保存只使用已确认版本，不能绕过冲突、核对或未知结果。
  async function save(): Promise<boolean> {
    const before = journal.snapshot;
    if (before.saving || !before.state || !before.draft || before.conflict || before.inventoryConflict || before.review || before.unknownSave) return false;
    if (layoutIssue(before.state, before.draft.placements)) return false;
    journal.original = structuredClone({ expected_version: before.state.version, scene_key: before.state.scene_key, ...before.draft });
    return writeOriginal(client, journal);
  }
  // 读回原版本后显式重发，保留原 expected_version 而不覆盖新版本。
  async function retryOriginal(): Promise<boolean> {
    if (!journal.snapshot.unknownSave || !journal.snapshot.canRetryOriginal) return false;
    return writeOriginal(client, journal);
  }
  // 显式读取后允许核对布局和库存；未知原版本不能被确认跳过。
  function confirmReview() {
    if (journal.snapshot.review && !journal.snapshot.unknownSave && !journal.snapshot.saving) publish(journal, { review: false, error: null });
  }
  const view = useMemo(() => state ? (draft ? { ...state, ...draft, scene: { ...state.scene, house: houseForPlacements(state,draft.placements) } } : state) : null, [state, draft]);
  return { ...snapshot, state, view, editing: draft !== null, dirty: !!(state && draft && !sameLayout(state, draft)), canLeave: !snapshot.saving && !snapshot.unknownSave, begin, cancel, setPlacements, setEnvironment, save, retryOriginal, readLatest, confirmReview };
}
