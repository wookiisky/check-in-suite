import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { Achievement } from './types';
import { badgeURL } from './achievement-format';
import { AchievementDetails } from './AchievementDetails';
import content from './content.json';
import './achievements.css';

// 打卡页展示所有已获得徽章，折叠状态仅在同一浏览器和账户中恢复。
export function AchievementStrip({ items, accountID, renderCharacter }: {
  items: Achievement[]; // 当前账户已获得的徽章。
  accountID: number; // 区分浏览器内保存的折叠偏好。
  renderCharacter: (badgeToggle: ReactNode) => ReactNode; // 将开关放进形象预览。
}) {
  const [selected, setSelected] = useState<Achievement | null>(null);
  const key = `island.achievement-badges.collapsed.${accountID}`;
  const badgesId = useId();
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(key) === '1'; }
    catch { return false; }
  });

  // 本地偏好不可用时仍可折叠，不影响读取徽章。
  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(key, next ? '1' : '0'); }
    catch { /* 不阻塞当前页面的展开或折叠。 */ }
  }

  const hasBadges = items.length > 0;
  return <>
    {renderCharacter(hasBadges && <button type="button" className="secondary achievement-badge-toggle" aria-label={content.badgeTitle} title={content.badgeTitle} aria-expanded={!collapsed} aria-controls={badgesId} onClick={toggle}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24"><path d="m5 9 7 7 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>)}
    {hasBadges && <section id={badgesId} hidden={collapsed} aria-label={content.badgeTitle}>
      {!collapsed && <div className="achievement-badges">{items.map((item) => <button type="button" key={item.id} className="achievement-badge" aria-label={`${content.details} ${item.name}`} onClick={(event) => { event.currentTarget.focus(); setSelected(item); }}><img src={badgeURL(item.asset_key)} alt="" /></button>)}</div>}
    </section>}
    {hasBadges && selected && <AchievementDetails item={selected} onClose={() => setSelected(null)} />}
  </>;
}
