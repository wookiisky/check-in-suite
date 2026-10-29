import { useEffect, useRef, useState } from 'react';
import type { Achievement, AchievementProps } from './types';
import { achievementError, achievementWindow, badgeURL } from './achievement-format';
import { AchievementProgress, AchievementRule } from './AchievementRule';
import { AchievementDetails } from './AchievementDetails';
import content from './content.json';
import './achievements.css';

// 成就资格以服务端为准，未确认佩戴结果时保留原状态。
export function AchievementPage({ client }: AchievementProps) {
  const [items, setItems] = useState<Achievement[]>([]);
  const [filter, setFilter] = useState<'all' | 'owned' | 'unowned'>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [revision, refresh] = useState(0);
  const [selected, setSelected] = useState<Achievement | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void client.request<{ items: Achievement[] }>('/achievements', { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setItems(result.items);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, revision]);

  // 使用逐项设置而非整组覆盖，重试同一操作不会重复佩戴。
  async function equip(item: Achievement) {
    if (busy || loading) return;
    setBusy(true); setError(null); setNotice('');
    try {
      const result = await client.request<Achievement>(`/achievements/${item.id}/equipment`, { method: 'PUT', body: { equipped: !item.equipped } });
      if (!mounted.current) return;
      setItems((current) => current.map((entry) => entry.id === result.id ? result : entry));
      setNotice(content.equipmentSaved);
    } catch (failure) { if (mounted.current) setError(failure); }
    finally { if (mounted.current) setBusy(false); }
  }
  const shown = items.filter((item) => filter === 'all' || item.qualified === (filter === 'owned'));
  return <div className="achievement-workspace">
    <h1>{content.title}</h1>
    <div className="achievement-actions" aria-label={content.title}>{(['all', 'owned', 'unowned'] as const).map((value) => <button className="secondary" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{content[value]}</button>)}</div>
    {notice && <p role="status" className="notice">{notice}</p>}
    {error !== null && <div role="alert"><p>{achievementError(error)}</p><button className="secondary" disabled={busy} onClick={() => refresh((value) => value + 1)}>{content.reload}</button></div>}
    {loading ? <p role="status">{content.loading}</p> : <div className="achievement-grid">
      {shown.length === 0 && <p>{content.empty}</p>}
      {shown.map((item) => <article className={`panel achievement-card ${item.qualified ? 'is-owned' : ''}`} key={item.id}>
        <button className="secondary achievement-preview" aria-label={`${content.details} ${item.name}`} onClick={(event) => { event.currentTarget.focus(); setSelected(item); }}><img className="achievement-art" src={badgeURL(item.asset_key)} alt="" /></button>
        <h2>{item.name}</h2><p className="achievement-state">{item.equipped ? content.equipped : item.qualified ? content.owned : content.unowned}</p>
        <p><AchievementRule item={item} /></p><p className="achievement-hint">{achievementWindow(item.window_days)}</p>
        <label className="achievement-progress"><span>{content.progress} <AchievementProgress item={item} /></span><progress max={item.target} value={Math.min(item.progress, item.target)} /></label>
        {item.qualified && <button disabled={busy} className={item.equipped ? 'secondary' : undefined} onClick={() => void equip(item)}>{item.equipped ? content.unequip : content.equip}</button>}
      </article>)}
    </div>}
    {selected && <AchievementDetails item={selected} onClose={() => setSelected(null)} />}
  </div>;
}
