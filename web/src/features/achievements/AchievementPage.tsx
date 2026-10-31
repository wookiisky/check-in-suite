import { useEffect, useRef, useState } from 'react';
import type { Achievement, AchievementProps } from './types';
import { achievementError, badgeURL } from './achievement-format';
import { AchievementProgress, AchievementRule } from './AchievementRule';
import { AchievementDetails } from './AchievementDetails';
import content from './content.json';
import './achievements.css';

// 嵌入式徽章管理与角色预览共享已确认的服务端结果。
interface AchievementPanelProps {
  client: AchievementProps['client']; // 当前会话的请求客户端。
  onItemsChange?: (items: Achievement[]) => void; // 完整列表供预览选出已佩戴徽章。
  onBusyChange?: (busy: boolean) => void; // 写入期间阻止外层关闭或切换分类。
}

// 独立页面包装保留既有调用，统一背包直接使用内容组件。
export function AchievementPage(props: AchievementProps) {
  return <div className="achievement-workspace"><h1>{content.title}</h1><AchievementPanel client={props.client} /></div>;
}

// 成就资格以服务端为准，未确认佩戴结果时保留原状态。
export function AchievementPanel({ client, onItemsChange, onBusyChange }: AchievementPanelProps) {
  const [items, setItems] = useState<Achievement[]>([]);
  const [filter, setFilter] = useState<'all' | 'owned' | 'unowned'>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [revision, refresh] = useState(0);
  const [selected, setSelected] = useState<Achievement | null>(null);
  const generation = useRef(0);
  const writing = useRef(false);
  const callbacks = useRef({ onItemsChange, onBusyChange });
  callbacks.current = { onItemsChange, onBusyChange };
  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoading(true); setError(null); setBusy(false);
    writing.current = false;
    void client.request<{ items: Achievement[] }>('/achievements', { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || generation.current !== current) return;
      setItems(result.items);
      callbacks.current.onItemsChange?.(result.items);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => {
      controller.abort();
      generation.current += 1;
      if (writing.current) callbacks.current.onBusyChange?.(false);
      writing.current = false;
    };
  }, [client, revision]);

  // 使用逐项设置而非整组覆盖，重试同一操作不会重复佩戴。
  async function equip(item: Achievement) {
    if (writing.current || loading) return;
    const current = generation.current;
    writing.current = true;
    setBusy(true); setError(null); setNotice('');
    callbacks.current.onBusyChange?.(true);
    try {
      const result = await client.request<Achievement>(`/achievements/${item.id}/equipment`, { method: 'PUT', body: { equipped: !item.equipped } });
      if (generation.current !== current) return;
      const next = items.map((entry) => entry.id === result.id ? result : entry);
      setItems(next);
      callbacks.current.onItemsChange?.(next);
      setNotice(content.equipmentSaved);
    } catch (failure) { if (generation.current === current) setError(failure); }
    finally {
      if (generation.current === current) {
        writing.current = false;
        setBusy(false);
        callbacks.current.onBusyChange?.(false);
      }
    }
  }
  const shown = items.filter((item) => filter === 'all' || item.qualified === (filter === 'owned'));
  return <div className="achievement-workspace">
    <div className="achievement-actions" aria-label={content.title}>{(['all', 'owned', 'unowned'] as const).map((value) => <button className="secondary" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{content[value]}</button>)}</div>
    {notice && <p role="status" className="notice">{notice}</p>}
    {error !== null && <div role="alert"><p>{achievementError(error)}</p><button className="secondary" disabled={busy} onClick={() => refresh((value) => value + 1)}>{content.reload}</button></div>}
    {loading ? <p role="status">{content.loading}</p> : <div className="achievement-grid">
      {shown.length === 0 && <p>{content.empty}</p>}
      {shown.map((item) => <article className={`panel achievement-card ${item.qualified ? 'is-owned' : ''}`} key={item.id}>
        <h2>{item.name}</h2>
        <button className="secondary achievement-preview" aria-label={`${content.details} ${item.name}`} onClick={(event) => { event.currentTarget.focus(); setSelected(item); }}><img className="achievement-art" src={badgeURL(item.asset_key)} alt="" /></button>
        <p><AchievementRule item={item} /></p>
        <label className="achievement-progress"><span><AchievementProgress item={item} /></span><progress aria-label={content.progress} max={item.target} value={Math.min(item.progress, item.target)} /></label>
        {item.qualified ? <button disabled={busy} className={item.equipped ? 'secondary' : undefined} onClick={() => void equip(item)}>{item.equipped ? content.unequip : content.equip}</button> : <p className="achievement-state">{content.unowned}</p>}
      </article>)}
    </div>}
    {selected && <AchievementDetails item={selected} onClose={() => setSelected(null)} />}
  </div>;
}
