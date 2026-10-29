import { Modal } from '../../components/Modal';
import type { Achievement } from './types';
import { achievementRule, achievementTargetName, achievementTime, achievementWindow, badgeURL } from './achievement-format';
import content from './content.json';

// 徽章详情同时支持触控和键盘，不依赖悬停提示。
export function AchievementDetails({ item, onClose }: { item: Achievement; onClose: () => void }) {
  return <Modal title={item.name} onClose={onClose}>
    <div className="achievement-details">
      <img className="achievement-art" src={badgeURL(item.asset_key)} alt="" />
      <p>{achievementRule(item)}</p><p>{achievementWindow(item.window_days)}</p>
      {item.scope !== 'all' && <section className="achievement-targets" aria-label={content.scope}>
        <p>{content.scope}</p>
        {item.category && <p>{achievementTargetName(item.category)}</p>}
        {item.scope === 'tasks' && <ul>{item.tasks.map((task) => <li key={task.id}>{achievementTargetName(task)}</li>)}</ul>}
      </section>}
      <p>{content.progress} {item.progress} / {item.target}</p>
      {item.earned_at && <p>{content.earnedAt} <time dateTime={item.earned_at}>{achievementTime(item.earned_at)}</time></p>}
      <p className="achievement-hint">{content.historyHint}</p>
    </div>
  </Modal>;
}
