import { useState } from 'react';
import type { Achievement } from './types';
import { badgeURL } from './achievement-format';
import { AchievementDetails } from './AchievementDetails';
import content from './content.json';
import './achievements.css';

// 营地只展示已佩戴徽章，文字和规则放在可操作的详情中。
export function AchievementStrip({ items, onViewAll }: { items: Achievement[]; onViewAll: () => void }) {
  const [selected, setSelected] = useState<Achievement | null>(null);
  return <section className="achievement-strip panel" aria-label={content.equippedTitle}>
    <h3>{content.equippedTitle}</h3>
    {items.length === 0 ? <p className="achievement-hint">{content.emptyEquipped}</p> : <div className="achievement-badges">{items.map((item) => <button key={item.id} className="secondary achievement-badge" aria-label={`${content.details} ${item.name}`} onClick={(event) => { event.currentTarget.focus(); setSelected(item); }}><img src={badgeURL(item.asset_key)} alt="" /></button>)}</div>}
    <button className="secondary" onClick={onViewAll}>{content.viewAll}</button>
    {selected && <AchievementDetails item={selected} onClose={() => setSelected(null)} />}
  </section>;
}
