import { CurrencyIcon } from '../../components/CurrencyAmount';
import { useEffect, useState } from 'react';
import type { components } from '../../api/schema';
import { ApiFailure } from '../../api/client';
import { Modal } from '../../components/Modal';
import { FieldError } from '../../components/FormFeedback';
import type { Session } from '../../api/types';
import type { Category, CheckinClient, Task } from './types';
import { checkinError, isDefiniteFailure } from './format';
import { createIdempotencyKey } from '../../api/idempotency-key';
import content from './content.json';

/** 配置新增也保留原命令，关闭弹窗后仍可按原键恢复。 */
interface ConfigCommand {
  path: string; // 原创建接口。
  key: string; // 原幂等键。
  body: unknown; // 原请求快照。
}
export const pendingConfiguration = new WeakMap<CheckinClient, ConfigCommand>();

/** 类别和任务只共享结构相同的名称表单，其余字段显式显示。 */
interface ConfigDialogProps {
  client: CheckinClient; // 已认证请求客户端。
  session: Session; // 服务器配置的输入上限。
  kind: 'category' | 'task'; // 当前编辑实体。
  item: Category | Task | null; // 空值表示新增。
  categories: Category[]; // 任务可选择的类别。
  onClose: () => void; // 关闭并让父页面显示待核对状态。
  onSaved: () => void; // 写成功后只刷新读取。
}

/** 配置提交保留草稿，未知新增结果不能换键重建。 */
export function ConfigDialog({ client, session, kind, item, categories, onClose, onSaved }: ConfigDialogProps) {
  const task = item && 'weekdays' in item ? item : null;
  const category = item && 'sort_order' in item ? item : null;
  const [name, setName] = useState(item?.name ?? '');
  const [sortOrder, setSortOrder] = useState(category?.sort_order ?? 0);
  const [categoryID, setCategoryID] = useState(task?.category_id ?? '');
  const [categoryOptions, setCategoryOptions] = useState(categories);
  const [icon, setIcon] = useState(task?.icon_key ?? '');
  const [assets, setAssets] = useState<components['schemas']['Asset'][]>([]);
  const [coins, setCoins] = useState(task?.coin_reward ?? 0);
  const [diamonds, setDiamonds] = useState(task?.diamond_reward ?? 0);
  const [dailyLimit, setDailyLimit] = useState(task?.daily_limit ?? 1);
  const [weekdays, setWeekdays] = useState(task?.weekdays ?? [1, 2, 3, 4, 5, 6, 7]);
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [unlockActivities, setUnlockActivities] = useState<Task['unlock_activities']>(task?.unlock_activities ?? []);
  const activityOptions: NonNullable<components['schemas']['IslandDefinition']['activity']>[] = ['read', 'run', 'ball'];
  const [version, setVersion] = useState(item?.version ?? 1);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [latest, setLatest] = useState<Task | Category | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [unknown, setUnknown] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const path = `/management/${kind === 'task' ? 'tasks' : 'categories'}`;
  const title = kind === 'task' ? item ? content.editTask : content.newTask : item ? content.editCategory : content.newCategory;
  const invalidDraft = [...name.trim()].length > session.limits.name_max || (kind === 'task' && (weekdays.length === 0 || !icon));
  const latestTask = latest && 'weekdays' in latest ? latest : null;
  const latestCategory = latest && 'sort_order' in latest ? latest : null;

  useEffect(() => {
    if (kind !== 'task') return;
    let active = true;
    void client.request<components['schemas']['AssetList']>('/assets').then((result) => {
      if (!active) return;
      const icons = result.items.filter((asset) => asset.kind === 'icon');
      setAssets(icons); setIcon((current) => current || icons[0]?.key || '');
    }).catch((failure: unknown) => { if (active) setError(failure); });
    return () => { active = false; };
  }, [client, kind]);

  // 每次保存只在明确的新命令开始时生成幂等键。
  async function save(confirmedVersion?: number) {
    if (busy || invalidDraft || (needsConfirmation && (!latest || confirmedVersion !== latest.version))) return;
    setBusy(true); setError(null);
    const draft = kind === 'task' ? { name, category_id: categoryID || null, icon_key: icon, coin_reward: coins, diamond_reward: diamonds, daily_limit: dailyLimit, weekdays, enabled, unlock_activities: unlockActivities } : { name, sort_order: sortOrder };
    const command = pendingConfiguration.get(client) ?? { path, key: createIdempotencyKey(), body: draft };
    if (!item) pendingConfiguration.set(client, command);
    try {
      if (item) await client.request(`${path}/${item.id}`, { method: 'PATCH', body: { ...draft, expected_version: confirmedVersion ?? version } });
      else await client.request(command.path, { method: 'POST', body: command.body, idempotencyKey: command.key });
      if (!item) pendingConfiguration.delete(client);
      onSaved(); onClose();
    } catch (failure) {
      setError(failure);
      if (failure instanceof ApiFailure && failure.detail.code === 'VERSION_CONFLICT') {
        setNeedsConfirmation(true); setLatest(null);
      }
      const unresolved = !item && !isDefiniteFailure(failure);
      setUnknown(unresolved);
      if (!item && !unresolved) pendingConfiguration.delete(client);
    } finally { setBusy(false); }
  }

  // 读取最新字段供核对；用户尚未选择前不能把新版本套在旧草稿上。
  async function confirmVersion() {
    if (busy) return;
    setBusy(true); setError(null); setLatest(null);
    try {
      const [response, currentCategories] = await Promise.all([
        client.request<{ items: (Task | Category)[] }>(`/${kind === 'task' ? 'tasks' : 'categories'}?include_inactive=true`),
        kind === 'task' ? client.request<{ items: Category[] }>('/categories') : Promise.resolve({ items: categoryOptions }),
      ]);
      const found = response.items.find((entry) => entry.id === item?.id);
      if (!found) throw new ApiFailure(404, { code: 'NOT_FOUND', field_errors: {}, request_id: '' });
      setCategoryOptions(currentCategories.items); setLatest(found);
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }

  // 明确采用最新配置后再替换草稿，后续编辑以刚看到的版本为基准。
  function useLatest() {
    if (!latest || busy) return;
    setName(latest.name); setVersion(latest.version);
    if ('weekdays' in latest) {
      setCategoryID(latest.category_id ?? ''); setIcon(latest.icon_key);
      setCoins(latest.coin_reward); setDiamonds(latest.diamond_reward);
      setDailyLimit(latest.daily_limit); setWeekdays(latest.weekdays); setEnabled(latest.enabled);
      setUnlockActivities(latest.unlock_activities);
    } else setSortOrder(latest.sort_order);
    setNeedsConfirmation(false); setLatest(null); setError(null); setDirty(false);
  }

  return <Modal title={title} closeDisabled={busy} onClose={() => { if (dirty && !unknown) setDiscard(true); else onClose(); }}>
    {discard ? <div className="checkin-stack"><p>{content.discardQuestion}</p><button onClick={() => setDiscard(false)}>{content.keepEditing}</button><button className="secondary" onClick={onClose}>{content.discard}</button></div> : <form className="checkin-stack" onChange={() => setDirty(true)} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>{content.name}<input required value={name} disabled={unknown} onChange={(event) => setName(event.target.value)} /></label><FieldError error={error} field="name" />
      {kind === 'category' ? <label>{content.sortOrder}<input type="number" step="1" value={sortOrder} disabled={unknown} onChange={(event) => setSortOrder(Number(event.target.value))} /></label> : <>
        <div className="checkin-form-grid"><label>{content.category}<select value={categoryID} disabled={unknown} onChange={(event) => setCategoryID(event.target.value)}><option value="">{content.uncategorized}</option>{categoryID && !categoryOptions.some((entry) => entry.id === categoryID) && <option value={categoryID}>{content.unavailableCategory}</option>}{categoryOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
          <label>{content.icon}<select required value={icon} disabled={unknown} onChange={(event) => setIcon(event.target.value)}>{assets.map((asset) => <option key={asset.key} value={asset.key}>{asset.name}</option>)}</select></label>
          <label><CurrencyIcon currency="coins" /><input aria-label={content.coins} type="number" min="0" max={session.limits.reward_max} step="1" value={coins} disabled={unknown} onChange={(event) => setCoins(Number(event.target.value))} /></label>
          <label><CurrencyIcon currency="diamonds" /><input aria-label={content.diamonds} type="number" min="0" max={session.limits.reward_max} step="1" value={diamonds} disabled={unknown} onChange={(event) => setDiamonds(Number(event.target.value))} /></label>
          <label>{content.dailyLimit}<input type="number" min="1" max={session.limits.daily_limit_max} step="1" value={dailyLimit} disabled={unknown} onChange={(event) => setDailyLimit(Number(event.target.value))} /></label></div>
        <fieldset className="checkin-checks" disabled={unknown}><legend>{content.weekdaysLabel}</legend>{content.weekdays.map((label, index) => <label key={label}><input type="checkbox" checked={weekdays.includes(index + 1)} onChange={(event) => setWeekdays((values) => event.target.checked ? [...values, index + 1].sort() : values.filter((value) => value !== index + 1))} />{label}</label>)}</fieldset>
        {weekdays.length === 0 && <p role="alert">{content.weekdayRequired}</p>}<FieldError error={error} field="weekdays" />
        <fieldset className="checkin-checks" disabled={unknown}><legend>{content.unlockActivities}</legend>{activityOptions.map((activity) => <label key={activity}><input type="checkbox" checked={unlockActivities.includes(activity)} onChange={(event) => setUnlockActivities((values) => event.target.checked ? [...values, activity] : values.filter((value) => value !== activity))} />{content.activityLabels[activity]}</label>)}</fieldset>
        <p>{content.unlockActivitiesHelp}</p><FieldError error={error} field="unlock_activities" />
        <label className="checkin-toggle"><input type="checkbox" checked={enabled} disabled={unknown} onChange={(event) => setEnabled(event.target.checked)} />{content.enabled}</label>
      </>}
      {unknown && <p role="status">{content.configUnknown}</p>}{error !== null && <p role="alert" className="checkin-error">{checkinError(error)}</p>}
      {needsConfirmation && <p role="status">{content.configurationConflictHelp}</p>}
      {needsConfirmation && !latest && <button type="button" className="secondary" disabled={busy} onClick={() => void confirmVersion()}>{content.confirmLatest}</button>}
      {latest && <section aria-label={content.latestConfiguration} className="checkin-warning checkin-stack">
        <h3>{content.latestConfiguration}</h3>
        <dl className="checkin-config-values">
          <dt>{content.name}</dt><dd>{latest.name}</dd>
          {latestCategory && <><dt>{content.sortOrder}</dt><dd>{latestCategory.sort_order}</dd></>}
          {latestTask && <>
            <dt>{content.category}</dt><dd>{latestTask.category_id === null ? content.uncategorized : categoryOptions.find((entry) => entry.id === latestTask.category_id)?.name ?? content.unavailableCategory}</dd>
            <dt>{content.icon}</dt><dd>{assets.find((asset) => asset.key === latestTask.icon_key)?.name ?? content.unavailableIcon}</dd>
            <dt><CurrencyIcon currency="coins" /></dt><dd>{latestTask.coin_reward}</dd>
            <dt><CurrencyIcon currency="diamonds" /></dt><dd>{latestTask.diamond_reward}</dd>
            <dt>{content.dailyLimit}</dt><dd>{latestTask.daily_limit}</dd>
            <dt>{content.weekdaysLabel}</dt><dd>{latestTask.weekdays.map((day) => content.weekdays[day - 1]).join(content.weekdaySeparator)}</dd>
            <dt>{content.unlockActivities}</dt><dd>{latestTask.unlock_activities.length ? latestTask.unlock_activities.map((activity) => content.activityLabels[activity]).join(content.weekdaySeparator) : content.noUnlockActivities}</dd>
            <dt>{content.configurationStatus}</dt><dd>{latestTask.enabled ? content.enabledStatus : content.disabled}</dd>
          </>}
        </dl>
        <button type="button" className="secondary" disabled={busy} onClick={useLatest}>{content.useLatestConfiguration}</button>
        <button type="button" disabled={busy || invalidDraft} onClick={(event) => { if (event.currentTarget.form?.reportValidity()) void save(latest.version); }}>{content.overwriteConfiguration}</button>
      </section>}
      <button type="submit" disabled={busy || needsConfirmation || invalidDraft}>{busy ? content.saving : unknown ? content.retryConfig : content.save}</button>
    </form>}
  </Modal>;
}
