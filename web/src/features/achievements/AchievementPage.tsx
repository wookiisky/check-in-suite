import { useEffect, useState } from 'react';
import type { Achievement, AchievementList, AchievementProps, AchievementTitle } from './types';
import { achievementError, badgeURL } from './achievement-format';
import { AchievementProgress, AchievementRule } from './AchievementRule';
import { AchievementDetails } from './AchievementDetails';
import { AchievementTitleButton } from './AchievementTitleButton';
import content from './content.json';
import './achievements.css';

// 普通成就页浏览资格和条件，并提供单个成就文本的选择入口。
export function AchievementPage({ client }: AchievementProps) {
  const [items, setItems] = useState<Achievement[]>([]);
  const [title, setTitle] = useState<AchievementTitle | null>(null);
  const [filter, setFilter] = useState<'all' | 'owned' | 'unowned'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [revision, refresh] = useState(0);
  const [selected, setSelected] = useState<Achievement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void client.request<AchievementList>('/achievements', { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setItems(result.items);
      setTitle(result.title ?? null);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [client, revision]);

  const shown = items.filter((item) => filter === 'all' || item.qualified === (filter === 'owned'));
  return <div className="achievement-workspace">
    <div className="achievement-page-heading">
      <h1>{content.title}</h1>
      {!loading && error === null && <AchievementTitleButton client={client} items={items} title={title} onSaved={setTitle} />}
    </div>
    <div className="achievement-actions" aria-label={content.title}>{(['all', 'owned', 'unowned'] as const).map((value) => <button className="secondary" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{content[value]}</button>)}</div>
    {error !== null && <div role="alert"><p>{achievementError(error)}</p><button className="secondary" onClick={() => refresh((value) => value + 1)}>{content.reload}</button></div>}
    {loading ? <p role="status">{content.loading}</p> : <div className="achievement-grid">
      {error === null && shown.length === 0 && <p>{content.empty}</p>}
      {shown.map((item) => <article className={`panel achievement-card ${item.qualified ? 'is-owned' : ''}`} key={item.id}>
        <h2>{item.name}</h2>
        <button className="secondary achievement-preview" aria-label={`${content.details} ${item.name}`} onClick={(event) => { event.currentTarget.focus(); setSelected(item); }}><img className="achievement-art" src={badgeURL(item.asset_key)} alt="" /></button>
        <p><AchievementRule item={item} /></p>
        <label className="achievement-progress"><span><AchievementProgress item={item} /></span><progress aria-label={content.progress} max={item.target} value={Math.min(item.progress, item.target)} /></label>
      </article>)}
    </div>}
    {selected && <AchievementDetails item={selected} onClose={() => setSelected(null)} />}
  </div>;
}
