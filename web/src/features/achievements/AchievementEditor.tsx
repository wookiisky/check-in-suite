import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure } from '../../api/client';
import { Modal } from '../../components/Modal';
import { FieldError } from '../../components/FormFeedback';
import type { Achievement, AchievementAsset, AchievementInput, AchievementOptions, AchievementProps } from './types';
import { achievementError, achievementRule, achievementTargetName, achievementWindow, badgeURL, isUncertainCreation } from './achievement-format';
import { pendingAchievements } from './achievement-pending';
import { createIdempotencyKey } from '../../api/idempotency-key';
import content from './content.json';

// 表单仅保留可修改字段，避免把资格和进度回传为配置。
function achievementDraft(item: Achievement | null, assets: AchievementAsset[]): AchievementInput {
  return item ? { name: item.name, asset_key: item.asset_key, metric: item.metric, scope: item.scope, category_id: item.category_id, task_ids: [...item.task_ids], target: item.target, window_days: item.window_days, enabled: item.enabled } : { name: '', asset_key: assets.find((asset) => asset.kind === 'badge')?.key ?? '', metric: 'count', scope: 'all', category_id: null, task_ids: [], target: 10, window_days: null, enabled: true };
}

// 编辑冲突先展示当前配置，再让用户选择保留草稿或采用当前值。
export function AchievementEditor({ client, session, item, assets, options, onClose, onSaved }: AchievementProps & { item: Achievement | null; assets: AchievementAsset[]; options: AchievementOptions; onClose: () => void; onSaved: () => void }) {
  const [initial, setInitial] = useState(() => item ? achievementDraft(item, assets) : pendingAchievements.get(client)?.body ?? achievementDraft(null, assets));
  const [draft, setDraft] = useState<AchievementInput>(initial);
  const [pending, setPending] = useState(item ? null : pendingAchievements.get(client) ?? null);
  const [version, setVersion] = useState(item?.version ?? 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Achievement | null>(null);
  const [targets, setTargets] = useState(options);
  const [discarding, setDiscarding] = useState(false);
  const mounted = useRef(true);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const invalid = draft.scope === 'tasks' && draft.task_ids.length === 0;
  function update(change: Partial<AchievementInput>) { setDraft((current) => ({ ...current, ...change })); }
  function close() {
    if (busy) return;
    if (!pending && JSON.stringify(draft) !== JSON.stringify(initial)) setDiscarding(true);
    else onClose();
  }

  // 新增未知结果只恢复原请求；版本冲突必须显式传入已核对版本。
  async function save(confirmedVersion?: number) {
    if (busy || invalid || (conflict && (!latest || confirmedVersion !== latest.version))) return;
    if (!form.current?.reportValidity()) return;
    setBusy(true); setError(null);
    const command = pending ?? { key: createIdempotencyKey(), body: { ...draft, task_ids: [...draft.task_ids] } };
    if (!item) { pendingAchievements.set(client, command); setPending(command); }
    try {
      if (item) await client.request<Achievement>(`/management/achievements/${item.id}`, { method: 'PATCH', body: { ...draft, expected_version: confirmedVersion ?? version } });
      else await client.request<Achievement>('/management/achievements', { method: 'POST', body: command.body, idempotencyKey: command.key });
      if (!item) pendingAchievements.delete(client);
      if (mounted.current) { setPending(null); onSaved(); }
    } catch (failure) {
      if (!item && !isUncertainCreation(failure)) pendingAchievements.delete(client);
      if (!mounted.current) return;
      setError(failure);
      if (!item && !isUncertainCreation(failure)) setPending(null);
      if (failure instanceof ApiFailure && failure.detail.code === 'VERSION_CONFLICT') { setConflict(true); setLatest(null); }
    } finally { if (mounted.current) setBusy(false); }
  }

  // 配置和关联选项全部刷新成功后才允许确认，失败时保留草稿和原版本。
  async function loadLatest() {
    if (!item || busy) return;
    setBusy(true); setError(null); setLatest(null);
    try {
      const [result, currentTargets] = await Promise.all([
        client.request<{ items: Achievement[] }>('/management/achievements'),
        client.request<AchievementOptions>('/management/achievements/options'),
      ]);
      const current = result.items.find((entry) => entry.id === item.id && !entry.deleted);
      if (!current) throw new ApiFailure(404, { code: 'NOT_FOUND', field_errors: {}, request_id: '' });
      if (mounted.current) { setTargets(currentTargets); setLatest(current); }
    } catch (failure) { if (mounted.current) setError(failure); }
    finally { if (mounted.current) setBusy(false); }
  }

  function submit(event: FormEvent) { event.preventDefault(); void save(); }
  function useLatest() {
    if (!latest) return;
    const current = achievementDraft(latest, assets);
    setInitial(current); setDraft(current); setVersion(latest.version); setLatest(null); setConflict(false); setError(null);
  }

  return <Modal title={item ? content.editTitle : content.new} onClose={close} closeDisabled={busy}>
    {discarding ? <div className="achievement-workspace"><p>{content.discardQuestion}</p><button onClick={() => setDiscarding(false)}>{content.keepEditing}</button><button className="secondary" onClick={onClose}>{content.discard}</button></div> : <form ref={form} className="achievement-form" onSubmit={submit}>
      <fieldset disabled={busy || Boolean(pending)} className="achievement-fields">
        <label>{content.name}<input value={draft.name} required maxLength={session.limits.name_max} onChange={(event) => update({ name: event.target.value })} /></label><FieldError error={error} field="name" />
        <label>{content.asset}<select value={draft.asset_key} required onChange={(event) => update({ asset_key: event.target.value })}><option value="">{content.chooseAsset}</option>{assets.filter((asset) => asset.kind === 'badge').map((asset) => <option key={asset.key} value={asset.key}>{asset.name}</option>)}</select></label><FieldError error={error} field="asset_key" />
        {draft.asset_key && <img className="achievement-form-art" src={badgeURL(draft.asset_key)} alt="" />}
        <label>{content.metric}<select value={draft.metric} onChange={(event) => update({ metric: event.target.value as AchievementInput['metric'] })}>{Object.entries(content.metrics).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>{content.target}<input type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} required value={draft.target} onChange={(event) => update({ target: Number(event.target.value) })} /></label><FieldError error={error} field="target" />
        <label>{content.scope}<select value={draft.scope} onChange={(event) => update({ scope: event.target.value as AchievementInput['scope'], category_id: null, task_ids: [] })}>{Object.entries(content.scopes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {draft.scope === 'category' && <><label>{content.category}<select value={draft.category_id ?? ''} required onChange={(event) => update({ category_id: event.target.value || null })}><option value="">{content.chooseCategory}</option>{targets.categories.map((category) => <option key={category.id} value={category.id} disabled={category.deleted && initial.category_id !== category.id}>{achievementTargetName(category)}</option>)}</select></label><FieldError error={error} field="category_id" /></>}
        {draft.scope === 'tasks' && <fieldset className="achievement-task-choices"><legend>{content.tasks}</legend>{targets.tasks.map((task) => <label key={task.id} className="achievement-check"><input type="checkbox" checked={draft.task_ids.includes(task.id)} disabled={task.deleted && !initial.task_ids.includes(task.id)} onChange={(event) => update({ task_ids: event.target.checked ? [...draft.task_ids, task.id] : draft.task_ids.filter((id) => id !== task.id) })} />{achievementTargetName(task)}</label>)}{invalid && <p role="status">{content.tasksRequired}</p>}<FieldError error={error} field="task_ids" /></fieldset>}
        <label className="achievement-check"><input type="checkbox" checked={draft.window_days === null} onChange={(event) => update({ window_days: event.target.checked ? null : 30 })} />{content.unlimited}</label>
        {draft.window_days !== null && <><label>{content.windowDays}<input type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} required value={draft.window_days} onChange={(event) => update({ window_days: Number(event.target.value) })} /></label><FieldError error={error} field="window_days" /></>}
        <label className="achievement-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} />{content.enabled}</label>
      </fieldset>
      <p className="achievement-hint">{draft.metric === 'streak' ? content.streakHint : draft.metric === 'coins' || draft.metric === 'diamonds' ? content.currencyHint : content.scopeHint}</p>
      <p className="achievement-hint">{content.changeHint}</p>
      {pending && !busy && <p role="status">{content.pendingCreate}</p>}
      {error !== null && <p role="alert">{achievementError(error)}</p>}
      {conflict && <p role="status">{content.conflict}</p>}
      {conflict && !latest && <button type="button" className="secondary" disabled={busy} onClick={() => void loadLatest()}>{content.reloadLatest}</button>}
      {latest && <section className="achievement-latest" aria-label={content.latest}><h3>{content.latest}</h3><img className="achievement-form-art" src={badgeURL(latest.asset_key)} alt="" /><p>{latest.name}</p><p>{achievementRule(latest)}</p><p>{achievementWindow(latest.window_days)}</p><p>{latest.enabled ? content.active : content.disabled}</p>
        {latest.category_id && <p>{targets.categories.find((category) => category.id === latest.category_id)?.name ?? content.unavailableTarget}</p>}
        {latest.task_ids.length > 0 && <ul>{latest.task_ids.map((id) => <li key={id}>{targets.tasks.find((task) => task.id === id)?.name ?? content.unavailableTarget}</li>)}</ul>}
        <div className="achievement-actions"><button type="button" className="secondary" disabled={busy} onClick={useLatest}>{content.useLatest}</button><button type="button" disabled={busy || invalid} onClick={() => void save(latest.version)}>{content.confirmDraft}</button></div></section>}
      <button type="submit" disabled={busy || conflict || invalid}>{busy ? content.saving : pending ? content.retryCreate : content.save}</button>
    </form>}
  </Modal>;
}
