import type { ReactNode } from 'react';
import { useAppearance } from './AppearanceProvider';
import { CharacterPreview3D } from './CharacterPreview3D';
import content from './character-panel-content.json';
import './character-panel.css';

// 打卡页展示已保存的外观和当前佩戴的成就文本。
export function CharacterPanel({ username, title, reduceMotion = false, onAchievements, badgeToggle }: {
  username: string; // 当前账户的用户名。
  title?: string | null; // 已佩戴的成就文本。
  reduceMotion?: boolean; // 当前账户的动效偏好。
  onAchievements?: () => void; // 打开成就页。
  badgeToggle?: ReactNode; // 形象右下角的徽章开关。
}) {
  const { snapshot, loading, error, refresh } = useAppearance();
  return <section className="character-panel" aria-label={content.label}>
    <div className="character-panel-heading">
      <h3>{username}</h3>
      {title && <strong className="character-panel-title">{title}</strong>}
      {onAchievements && <button type="button" className="secondary character-achievements" aria-label={content.achievements} onClick={onAchievements}>
        <img src="/api/v1/assets/crown-v1" alt="" />
      </button>}
    </div>
    <div className="character-panel-preview">
      {snapshot && <CharacterPreview3D snapshot={snapshot} paused={reduceMotion} rotatable showRotationControls={false} />}
      {!snapshot && loading && <p role="status">{content.loading}</p>}
      {badgeToggle && <div className="character-panel-badge-toggle">{badgeToggle}</div>}
    </div>
    {error !== null && <div role="alert"><p>{content.error}</p><button className="secondary" disabled={loading} onClick={() => void refresh()}>{content.retry}</button></div>}
  </section>;
}
