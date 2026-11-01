import type { components } from '../../api/schema';
import { useAppearance } from './AppearanceProvider';
import { CharacterPreview3D } from './CharacterPreview3D';
import content from './character-panel-content.json';
import './character-panel.css';

// 首页只展示已保存的外观；称号属于独立的 HTML 展示和保存边界。
export function CharacterPanel({ equipment, displayName, reduceMotion = false, onAppearance, onTitle }: {
  equipment: components['schemas']['Equipment'];
  displayName: string;
  reduceMotion?: boolean;
  onAppearance?: () => void;
  onTitle?: () => void;
}) {
  const { snapshot, loading, error, refresh } = useAppearance();
  return <section className="character-panel" aria-label={content.label}>
    <h3>{displayName}</h3>
    {equipment.title && <p className="character-panel-title"><img src={`/api/v1/assets/${encodeURIComponent(equipment.title.asset_key_snapshot)}`} alt="" />{equipment.title.name_snapshot}</p>}
    {snapshot && <CharacterPreview3D snapshot={snapshot} paused={reduceMotion} />}
    {!snapshot && loading && <p role="status">{content.loading}</p>}
    {error !== null && <div role="alert"><p>{content.error}</p><button className="secondary" disabled={loading} onClick={() => void refresh()}>{content.retry}</button></div>}
    {/* Safari 轻触不自动聚焦，先记录入口再让 Modal 读取返回焦点。 */}
    {(onAppearance || onTitle) && <div className="character-panel-actions">
      {onAppearance && <button className="secondary" onClick={(event) => { event.currentTarget.focus(); onAppearance(); }}><img src="/api/v1/assets/icon-appearance-v1" alt="" />{content.appearance}</button>}
      {onTitle && <button className="secondary" onClick={(event) => { event.currentTarget.focus(); onTitle(); }}>{content.title}</button>}
    </div>}
  </section>;
}
