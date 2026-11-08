import { useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { achievementError } from './achievement-format';
import type { Achievement, AchievementClient, AchievementList, AchievementTitle } from './types';
import content from './content.json';
import './achievements.css';

// 成就页只允许选择已获得的文本。
interface AchievementTitleButtonProps {
  client: AchievementClient; // 当前账户的请求入口。
  items: Achievement[]; // 最近确认的成就资格。
  title: AchievementTitle | null; // 最近确认的佩戴文本。
  onSaved: (title: AchievementTitle | null) => void; // 同步同页所用的文本。
}

// 失败时先读回实际佩戴和资格，再允许下一次选择。
export function AchievementTitleButton({ client, items, title, onSaved }: AchievementTitleButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [latestItems, setLatestItems] = useState<Achievement[] | null>(null);
  const running = useRef(false);
  const earned = (latestItems ?? items).filter((item) => item.qualified);

  // 使用绝对值提交，收到结果后才替换显示文本。
  async function save(id: string | null) {
    if (running.current || error !== null) return;
    running.current = true;
    setBusy(true);
    try {
      const result = await client.request<{ title: AchievementTitle | null }>('/achievements/title', { method: 'PUT', body: { achievement_id: id } });
      onSaved(result.title);
      setOpen(false);
    } catch (failure) {
      setError(failure);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  // 读回更新文本与选项。读取失败保留原文本和待核对状态。
  async function reload() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const result = await client.request<AchievementList>('/achievements');
      setLatestItems(result.items);
      onSaved(result.title ?? null);
      setError(null);
    } catch (failure) {
      setError(failure);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return <>
    <button type="button" className="secondary achievement-title-trigger" aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus(); setLatestItems(null); setOpen(true); }}>{title?.name ?? content.chooseTitle}</button>
    {open && <Modal title={content.chooseTitle} onClose={() => setOpen(false)} closeDisabled={busy}>
      <div className="achievement-workspace achievement-title-options" aria-busy={busy}>
        {error !== null && <div role="alert"><p>{achievementError(error)}</p><button className="secondary" disabled={busy} onClick={() => void reload()}>{content.reload}</button></div>}
        {!earned.length && error === null && <p>{content.emptyTitles}</p>}
        {earned.map((item) => <button key={item.id} className="secondary" aria-pressed={title?.id === item.id} disabled={busy || error !== null || title?.id === item.id} onClick={() => void save(item.id)}>{item.name}</button>)}
        {title && <button className="secondary" disabled={busy || error !== null} onClick={() => void save(null)}>{content.removeTitle}</button>}
      </div>
    </Modal>}
  </>;
}
