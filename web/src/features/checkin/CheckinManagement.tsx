import { CurrencyAmount } from '../../components/CurrencyAmount';
import { useEffect, useRef, useState } from 'react';
import type { components } from '../../api/schema';
import { ApiFailure } from '../../api/client';
import { Modal } from '../../components/Modal';
import { ViewTabs } from '../../components/ViewTabs';
import type { Category, CheckinProps, Task } from './types';
import { ConfigDialog, pendingConfiguration } from './ConfigDialog';
import { HistoryManagement } from './HistoryManagement';
import { TaskIcon } from './TaskIcon';
import { checkinError, isDefiniteFailure } from './format';
import content from './content.json';
import './checkin.css';

const uncategorizedTab = 'uncategorized';

/** 记录和配置分别加载，切换配置页后从对应列表重新开始。 */
export function CheckinManagement({ section, ...props }: CheckinProps & { section: 'categories' | 'tasks' | 'records' }) {
  if (section === 'records') return <HistoryManagement {...props} />;
  return <CheckinConfiguration key={section} {...props} section={section} />;
}

// 类别与项目共用写入恢复规则，列表各自展示。
function CheckinConfiguration({ client, session, section }: CheckinProps & { section: 'categories' | 'tasks' }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<{ kind: 'category' | 'task'; item: Category | Task | null } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'category' | 'task'; item: Category | Task } | null>(null);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState('');
  const [showDisabled, setShowDisabled] = useState(false);
  const [changingTask, setChangingTask] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const visibilityControl = useRef<HTMLInputElement>(null);
  const command = pendingConfiguration.get(client);
  const actionsDisabled = loading || busy || error !== null;
  const categoryTabs = [
    { id: '', label: content.allCategories },
    ...categories.map((item) => ({ id: item.id, label: item.name })),
    { id: uncategorizedTab, label: content.uncategorized },
  ];
  const selectedCategory = categoryTabs.some((item) => item.id === category) ? category : '';
  const categoryTasks = tasks.filter((task) => !selectedCategory || (task.category_id ?? uncategorizedTab) === selectedCategory);
  const visibleTasks = categoryTasks.filter((task) => showDisabled || task.enabled);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setMessage('');
    void Promise.all([
      client.request<{ items: Category[] }>('/categories?include_inactive=true'),
      section === 'tasks' ? client.request<{ items: Task[] }>('/tasks?include_inactive=true') : Promise.resolve({ items: [] }),
    ])
      .then(([categoryPage, taskPage]) => { if (active) { setCategories(categoryPage.items); setTasks(taskPage.items); } })
      .catch((failure: unknown) => { if (active) setError(failure); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, revision, section]);

  // 复用完整配置更新及版本校验；失联后只重读，不自动反转或覆盖新版本。
  async function changeTaskStatus(task: Task, trigger: HTMLButtonElement) {
    if (actionsDisabled || command) return;
    const hadFocus = document.activeElement === trigger;
    setBusy(true); setChangingTask(task.id); setError(null); setMessage('');
    const body: components['schemas']['TaskUpdate'] = {
      name: task.name, category_id: task.category_id, icon_key: task.icon_key,
      coin_reward: task.coin_reward, diamond_reward: task.diamond_reward,
      daily_limit: task.daily_limit, weekdays: task.weekdays, unlock_activities: task.unlock_activities,
      enabled: !task.enabled, expected_version: task.version,
    };
    try {
      const updated = await client.request<Task>(`/management/tasks/${task.id}`, { method: 'PATCH', body });
      // Chromium 禁用按钮会清空焦点；只在用户未移到其他控件时补回找回入口。
      const focusLost = hadFocus && document.activeElement === document.body;
      if (!updated.enabled && !visibilityControl.current?.checked && (document.activeElement === trigger || focusLost)) visibilityControl.current?.focus();
      setTasks((items) => items.map((item) => item.id === updated.id ? updated : item));
      setMessage(updated.enabled ? content.taskEnabled : content.taskDisabled);
    } catch (failure) {
      setError(failure); setMessage(content.taskStatusReload);
    } finally { setBusy(false); setChangingTask(null); }
  }

  // 删除必须确认目标及版本，停用项目仍受类别引用约束。
  async function remove() {
    if (!deleting) return;
    setBusy(true); setError(null);
    try {
      await client.request(`/management/${deleting.kind === 'task' ? 'tasks' : 'categories'}/${deleting.item.id}`, { method: 'DELETE', body: { expected_version: deleting.item.version } });
      setDeleting(null); refresh((value) => value + 1);
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }

  // 删除冲突只更新目标快照供再次确认，不自动删除新版本。
  async function refreshDeleteTarget() {
    if (!deleting) return;
    setBusy(true); setError(null);
    try {
      if (deleting.kind === 'task') {
        const response = await client.request<{ items: Task[] }>('/tasks?include_inactive=true');
        const found = response.items.find((item) => item.id === deleting.item.id);
        if (!found) throw new ApiFailure(404, { code: 'NOT_FOUND', field_errors: {}, request_id: '' });
        setTasks(response.items); setDeleting({ kind: 'task', item: found });
      } else {
        const response = await client.request<{ items: Category[] }>('/categories?include_inactive=true');
        const found = response.items.find((item) => item.id === deleting.item.id);
        if (!found) throw new ApiFailure(404, { code: 'NOT_FOUND', field_errors: {}, request_id: '' });
        setCategories(response.items); setDeleting({ kind: 'category', item: found });
      }
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }

  // 关闭未知新增弹窗后，仍只能按原命令核对，不开放另一笔新增。
  async function recoverConfiguration() {
    if (!command) return;
    setBusy(true); setError(null);
    try {
      await client.request(command.path, { method: 'POST', body: command.body, idempotencyKey: command.key });
      pendingConfiguration.delete(client); refresh((value) => value + 1);
    } catch (failure) {
      if (isDefiniteFailure(failure)) pendingConfiguration.delete(client);
      setError(failure);
    } finally { setBusy(false); }
  }

  return <div className="checkin-workspace checkin-management">
    {loading && <p role="status">{content.loading}</p>}
    {message && <p role="status" className={error === null ? 'checkin-notice' : 'checkin-warning'}>{message}</p>}
    {error !== null && <div role="alert" className="checkin-error"><p>{checkinError(error)}</p>{!deleting && <button className="secondary" disabled={busy} onClick={() => refresh((value) => value + 1)}>{content.reload}</button>}</div>}
    {command && !editing && <div className="checkin-warning"><p>{content.configUnknown}</p><button disabled={busy} onClick={() => void recoverConfiguration()}>{content.retryConfig}</button></div>}
    {section === 'categories' ? <section className="checkin-panel">
      <button disabled={actionsDisabled || Boolean(command)} onClick={() => setEditing({ kind: 'category', item: null })}>{content.newCategory}</button>
      {categories.length === 0 && !loading && error === null && <p>{content.emptyCategories}</p>}
      <ul className="checkin-config-list" role="list">{categories.map((item) => <li className="checkin-config-row" key={item.id}>
        <div><strong>{item.name}</strong><span className="checkin-config-meta">{content.sortOrder} {item.sort_order}</span></div>
        <div className="checkin-actions">
          <button className="secondary" disabled={actionsDisabled} onClick={() => setEditing({ kind: 'category', item })}>{content.editConfig}</button>
          <button className="secondary" disabled={actionsDisabled} onClick={() => setDeleting({ kind: 'category', item })}>{content.remove}</button>
        </div>
      </li>)}</ul>
    </section> : <section className="checkin-panel">
      <div className="checkin-management-toolbar">
        <button disabled={actionsDisabled || Boolean(command)} onClick={() => setEditing({ kind: 'task', item: null })}>{content.newTask}</button>
        <label className="checkin-toggle">
          <input ref={visibilityControl} type="checkbox" checked={showDisabled} onChange={(event) => setShowDisabled(event.target.checked)} />
          {content.showDisabledTasks}
        </label>
      </div>
      <ViewTabs label={content.category} items={categoryTabs} value={selectedCategory} onChange={setCategory}>
        {visibleTasks.length === 0 && !loading && error === null && <p>{categoryTasks.length === 0 ? content.emptyTasks : content.noActiveTasks}</p>}
        <ul className="checkin-config-list" role="list">{visibleTasks.map((item) => <li className="checkin-config-row" key={item.id}>
          <div className="checkin-config-task">
            <TaskIcon name={item.icon_key} />
            <div>
              <strong>{item.name}</strong><span className="checkin-config-meta">{item.enabled ? content.enabledStatus : content.disabled}</span>
              <div className="checkin-config-details">
                <CurrencyAmount currency="coins" amount={item.coin_reward} />
                <CurrencyAmount currency="diamonds" amount={item.diamond_reward} />
                <span>{content.dailyLimit} {item.daily_limit}</span>
              </div>
            </div>
          </div>
          <div className="checkin-actions">
            <button className="secondary" disabled={actionsDisabled || Boolean(command)} aria-label={`${item.enabled ? content.disableTask : content.enableTask} ${item.name}`} aria-busy={changingTask === item.id} onClick={(event) => void changeTaskStatus(item, event.currentTarget)}>{changingTask === item.id ? content.saving : item.enabled ? content.disableTask : content.enableTask}</button>
            <button className="secondary" disabled={actionsDisabled} onClick={() => setEditing({ kind: 'task', item })}>{content.editConfig}</button>
            <button className="secondary" disabled={actionsDisabled} onClick={() => setDeleting({ kind: 'task', item })}>{content.remove}</button>
          </div>
        </li>)}</ul>
      </ViewTabs>
    </section>}
    {editing && <ConfigDialog client={client} session={session} kind={editing.kind} item={editing.item} categories={categories}
      initialCategoryID={selectedCategory === uncategorizedTab ? '' : selectedCategory}
      onClose={() => setEditing(null)} onSaved={() => refresh((value) => value + 1)} />}
    {deleting && <Modal title={content.remove} closeDisabled={busy} onClose={() => setDeleting(null)}><div className="checkin-stack"><h3>{deleting.item.name}</h3><p>{content.configDeleteQuestion}</p>{deleting.kind === 'task' && <p>{content.taskDeleteUnlockWarning}</p>}{error !== null && <p role="alert">{checkinError(error)}</p>}{error instanceof ApiFailure && error.detail.code === 'VERSION_CONFLICT' && <button className="secondary" disabled={busy} onClick={() => void refreshDeleteTarget()}>{content.confirmLatest}</button>}<div className="checkin-actions"><button disabled={busy} onClick={() => void remove()}>{busy ? content.saving : content.remove}</button><button className="secondary" disabled={busy} onClick={() => setDeleting(null)}>{content.cancel}</button></div></div></Modal>}
  </div>;
}
