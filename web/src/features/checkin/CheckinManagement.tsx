import { useEffect, useState } from 'react';
import { ApiFailure } from '../../api/client';
import { Modal } from '../../components/Modal';
import type { Category, CheckinProps, Task } from './types';
import { ConfigDialog, pendingConfiguration } from './ConfigDialog';
import { HistoryManagement } from './HistoryManagement';
import { checkinError, isDefiniteFailure } from './format';
import content from './content.json';
import './checkin.css';

/** 配置与历史管理共用管理授权，但数据和编辑草稿保持各自独立。 */
export function CheckinManagement({ client, session, section }: CheckinProps & { section?: 'configuration' | 'records' }) {
  const [tab, setTab] = useState<'configuration' | 'records'>('configuration');
  const [categories, setCategories] = useState<Category[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<{ kind: 'category' | 'task'; item: Category | Task | null } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'category' | 'task'; item: Category | Task } | null>(null);
  const [busy, setBusy] = useState(false);
  const command = pendingConfiguration.get(client);
  const activeTab = section ?? tab;

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    void Promise.all([client.request<{ items: Category[] }>('/categories?include_inactive=true'), client.request<{ items: Task[] }>('/tasks?include_inactive=true')])
      .then(([categoryPage, taskPage]) => { if (active) { setCategories(categoryPage.items); setTasks(taskPage.items); } })
      .catch((failure: unknown) => { if (active) setError(failure); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, revision]);

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

  return <div className="checkin-workspace">
    {section === undefined && <div className="checkin-tabs" aria-label={content.categoriesTasks}><button className="secondary" aria-pressed={tab === 'configuration'} onClick={() => setTab('configuration')}>{content.categoriesTasks}</button><button className="secondary" aria-pressed={tab === 'records'} onClick={() => setTab('records')}>{content.manageRecords}</button></div>}
    {activeTab === 'records' ? <HistoryManagement client={client} session={session} /> : <>
      {loading && <p role="status">{content.loading}</p>}
      {error !== null && <div role="alert" className="checkin-error"><p>{checkinError(error)}</p>{!deleting && <button className="secondary" onClick={() => refresh((value) => value + 1)}>{content.reload}</button>}</div>}
      {command && !editing && <div className="checkin-warning"><p>{content.configUnknown}</p><button disabled={busy} onClick={() => void recoverConfiguration()}>{content.retryConfig}</button></div>}
      <section className="checkin-panel"><div className="checkin-section-heading"><h2>{content.categories}</h2><button disabled={loading || Boolean(command)} onClick={() => setEditing({ kind: 'category', item: null })}>{content.newCategory}</button></div>
        {categories.length === 0 && !loading && <p>{content.emptyCategories}</p>}{categories.map((item) => <div className="checkin-config-row" key={item.id}><strong>{item.name}</strong><div className="checkin-actions"><button className="secondary" onClick={() => setEditing({ kind: 'category', item })}>{content.editConfig}</button><button className="secondary" onClick={() => setDeleting({ kind: 'category', item })}>{content.remove}</button></div></div>)}
      </section>
      <section className="checkin-panel"><div className="checkin-section-heading"><h2>{content.tasks}</h2><button disabled={loading || Boolean(command)} onClick={() => setEditing({ kind: 'task', item: null })}>{content.newTask}</button></div>
        {tasks.length === 0 && !loading && <p>{content.emptyTasks}</p>}{tasks.map((item) => <div className="checkin-config-row" key={item.id}><div><strong>{item.name}</strong>{!item.enabled && <p className="checkin-hint">{content.disabled}</p>}<p className="checkin-hint">{content.coins} {item.coin_reward} · {content.diamonds} {item.diamond_reward} · {content.dailyLimit} {item.daily_limit}</p></div><div className="checkin-actions"><button className="secondary" onClick={() => setEditing({ kind: 'task', item })}>{content.editConfig}</button><button className="secondary" onClick={() => setDeleting({ kind: 'task', item })}>{content.remove}</button></div></div>)}
      </section>
    </>}
    {editing && <ConfigDialog client={client} session={session} kind={editing.kind} item={editing.item} categories={categories} onClose={() => setEditing(null)} onSaved={() => refresh((value) => value + 1)} />}
    {deleting && <Modal title={content.remove} closeDisabled={busy} onClose={() => setDeleting(null)}><div className="checkin-stack"><h3>{deleting.item.name}</h3><p>{content.configDeleteQuestion}</p>{error !== null && <p role="alert">{checkinError(error)}</p>}{error instanceof ApiFailure && error.detail.code === 'VERSION_CONFLICT' && <button className="secondary" disabled={busy} onClick={() => void refreshDeleteTarget()}>{content.confirmLatest}</button>}<div className="checkin-actions"><button disabled={busy} onClick={() => void remove()}>{busy ? content.saving : content.remove}</button><button className="secondary" disabled={busy} onClick={() => setDeleting(null)}>{content.cancel}</button></div></div></Modal>}
  </div>;
}
