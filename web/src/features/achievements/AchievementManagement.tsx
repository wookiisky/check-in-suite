import { useEffect, useRef, useState } from 'react';
import { ApiFailure } from '../../api/client';
import { Modal } from '../../components/Modal';
import type { Achievement, AchievementAsset, AchievementOptions, AchievementProps } from './types';
import { AchievementEditor } from './AchievementEditor';
import { achievementError, achievementWindow, badgeURL } from './achievement-format';
import { AchievementRule } from './AchievementRule';
import { pendingAchievements } from './achievement-pending';
import content from './content.json';
import './achievements.css';

// 管理配置和选择项同批加载，避免把已删除关联误当作空值覆盖。
export function AchievementManagement({ client, session }: AchievementProps) {
  const [items, setItems] = useState<Achievement[]>([]);
  const [assets, setAssets] = useState<AchievementAsset[]>([]);
  const [options, setOptions] = useState<AchievementOptions>({ tasks: [], categories: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [revision, refresh] = useState(0);
  const [editing, setEditing] = useState<Achievement | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Achievement | null>(null);
  const [deleteConflict, setDeleteConflict] = useState(false);
  const mounted = useRef(true);
  const pending = pendingAchievements.get(client);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void Promise.all([
      client.request<{ items: Achievement[] }>('/management/achievements', { signal: controller.signal }),
      client.request<{ items: AchievementAsset[] }>('/assets', { signal: controller.signal }),
      client.request<AchievementOptions>('/management/achievements/options', { signal: controller.signal }),
    ]).then(([list, artwork, targets]) => {
      if (!controller.signal.aborted) { setItems(list.items); setAssets(artwork.items); setOptions(targets); }
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, revision]);

  // 删除以展示过的版本确认，冲突后回到列表重新核对。
  async function remove() {
    if (!deleting || busy || deleteConflict) return;
    setBusy(true); setError(null);
    try {
      await client.request<void>(`/management/achievements/${deleting.id}`, { method: 'DELETE', body: { expected_version: deleting.version } });
      if (mounted.current) { setDeleting(null); setNotice(content.removed); refresh((value) => value + 1); }
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure);
      if (failure instanceof ApiFailure && failure.detail.code === 'VERSION_CONFLICT') setDeleteConflict(true);
    } finally { if (mounted.current) setBusy(false); }
  }
  function reload() { setDeleting(null); setDeleteConflict(false); refresh((value) => value + 1); }

  return <div className="achievement-workspace">
    <h1>{content.manageTitle}</h1>
    {notice && <p role="status" className="notice">{notice}</p>}
    {pending && <div className="notice"><p>{content.pendingCreate}</p><button disabled={loading} onClick={() => setEditing('new')}>{content.retryCreate}</button></div>}
    {error !== null && !deleting && <div role="alert"><p>{achievementError(error)}</p><button disabled={busy} className="secondary" onClick={reload}>{content.reload}</button></div>}
    <button disabled={loading || Boolean(pending) || error !== null} onClick={(event) => { event.currentTarget.focus(); setEditing('new'); }}>{content.new}</button>
    {loading ? <p role="status">{content.loading}</p> : <div className="achievement-management-list">
      {items.filter((item) => !item.deleted).length === 0 && <p>{content.emptyManagement}</p>}
      {items.filter((item) => !item.deleted).map((item) => <article className="panel achievement-management-row" key={item.id}>
        <img className="achievement-art" src={badgeURL(item.asset_key)} alt="" />
        <div><h2>{item.name}</h2><p><AchievementRule item={item} /></p><p className="achievement-hint">{achievementWindow(item.window_days)}</p><p>{item.enabled ? content.active : content.disabled}</p></div>
        <div className="achievement-actions"><button className="secondary" disabled={Boolean(pending) || error !== null} aria-label={`${content.edit} ${item.name}`} onClick={(event) => { event.currentTarget.focus(); setEditing(item); }}>{content.edit}</button><button className="secondary" disabled={Boolean(pending) || error !== null} aria-label={`${content.delete} ${item.name}`} onClick={(event) => { event.currentTarget.focus(); setError(null); setDeleteConflict(false); setDeleting(item); }}>{content.delete}</button></div>
      </article>)}
    </div>}
    {editing !== null && <AchievementEditor client={client} session={session} item={editing === 'new' ? null : editing} assets={assets} options={options} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice(content.saved); refresh((value) => value + 1); }} />}
    {deleting && <Modal title={content.deleteTitle} onClose={() => setDeleting(null)} closeDisabled={busy}><h3>{deleting.name}</h3><p>{content.deleteHint}</p>{error !== null && <p role="alert">{achievementError(error)}</p>}{deleteConflict && <><p>{content.deleteConflict}</p><button onClick={reload}>{content.reload}</button></>}<div className="achievement-actions"><button disabled={busy || deleteConflict} onClick={() => void remove()}>{busy ? content.saving : content.confirmDelete}</button><button className="secondary" disabled={busy} onClick={() => setDeleting(null)}>{content.cancel}</button></div></Modal>}
  </div>;
}
