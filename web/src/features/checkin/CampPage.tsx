import { CurrencyAmount } from '../../components/CurrencyAmount';
import { ViewTabs } from '../../components/ViewTabs';
import { useWalletSync } from '../../components/WalletContext';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { shiftDate } from '../../api/dates';
import type { Camp, Checkin, CheckinPage, CheckinProps, Task } from './types';
import { CheckinComposer } from './CheckinComposer';
import { RecordDialog } from './RecordDialog';
import { RecordList } from './RecordList';
import { TaskIcon } from './TaskIcon';
import { getPending } from './submission';
import { CREATE_DRAFT_KEY, getDraft } from './drafts';
import { checkinError } from './format';
import { CHECKIN_SUCCESS_EVENT, type CheckinSuccessDetail } from './events';
import { CheckinRewardFeedback } from './CheckinRewardFeedback';
import content from './content.json';
import './checkin.css';

/** 左侧固定显示今日记录和任务，切换任务类别不重新加载侧栏。 */
export function CampPage({ client, session, renderSidebar }: CheckinProps & { renderSidebar?: (camp: Camp) => ReactNode }) {
  const publishWallet = useWalletSync();
  const [camp, setCamp] = useState<Camp | null>(null);
  const [category, setCategory] = useState('');
  const [records, setRecords] = useState<Checkin[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [successID, setSuccessID] = useState('');
  const [reward, setReward] = useState<Checkin | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [selected, setSelected] = useState<Checkin | null>(null);
  const generation = useRef(0);
  const animatedRecords = useRef(new Set<string>());
  const pending = getPending(client);
  const draft = getDraft(client, CREATE_DRAFT_KEY);
  const today = camp?.today ?? session.today;

  useEffect(() => {
    let active = true;
    const requestGeneration = ++generation.current;
    setLoading(true); setLoadingMore(false); setError(null); setRecords([]); setCursor(null);
    void (async () => {
      try {
        const snapshot = await client.request<Camp>('/camp');
        if (!active || generation.current !== requestGeneration) return;
        client.recordServerTime?.(snapshot.server_now);
        setCamp(snapshot);
        publishWallet(snapshot.wallet);
        const page = await client.request<CheckinPage>(`/checkins?${new URLSearchParams({ start_date: snapshot.today, end_date: snapshot.today })}`);
        if (!active || generation.current !== requestGeneration) return;
        setRecords(page.items); setCursor(page.next_cursor);
      } catch (failure) { if (active) setError(failure); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [client, revision, publishWallet]);

  useEffect(() => {
    if (!camp) return;
    const offset = new Date(camp.server_now).getTime() - Date.now();
    const now = () => client.now?.().getTime() ?? Date.now() + offset;
    const nextMidnight = new Date(`${shiftDate(camp.today, 1)}T00:00:00+08:00`).getTime();
    const checkDay = () => {
      const serverDate = new Date(now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (serverDate !== camp.today) refresh((value) => value + 1);
    };
    const timer = window.setTimeout(checkDay, Math.max(100, nextMidnight - now() + 50));
    const visible = () => { if (document.visibilityState === 'visible') checkDay(); };
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [camp, client]);

  // 分页沿用当前日期范围，保留已加载内容，迟到响应不能混入新筛选。
  async function loadMore() {
    if (!cursor || loading || loadingMore) return;
    const requestGeneration = generation.current;
    setLoadingMore(true); setError(null);
    try {
      const page = await client.request<CheckinPage>(`/checkins?${new URLSearchParams({ start_date: today, end_date: today, cursor })}`);
      if (generation.current !== requestGeneration) return;
      setRecords((items) => [...items, ...page.items.filter((item) => !items.some((known) => known.id === item.id))]);
      setCursor(page.next_cursor);
    } catch (failure) { if (generation.current === requestGeneration) setError(failure); }
    finally { if (generation.current === requestGeneration) setLoadingMore(false); }
  }

  // 同一记录的幂等重放不重复播放成功反馈，编辑只给静态保存提示。
  function saved(notice: string, record?: Checkin, created = false) {
    setMessage(notice);
    if (created && record && !record.deleted && !animatedRecords.current.has(record.id)) {
      setSuccessID(record.id); animatedRecords.current.add(record.id);
      setReward(record);
      window.dispatchEvent(new CustomEvent<CheckinSuccessDetail>(CHECKIN_SUCCESS_EVENT, {
        detail: { recordId: record.id, coins: record.coin_reward_snapshot, diamonds: record.diamond_reward_snapshot },
      }));
    } else { setSuccessID(''); setReward(null); }
    refresh((value) => value + 1);
  }

  const activeCategory = camp?.categories.some((item) => item.id === category) ? category : '';
  const categories = [{ id: '', label: content.allCategories }, ...(camp?.categories.map((item) => ({ id: item.id, label: item.name })) ?? [])];
  const visibleTasks = camp?.tasks.filter((item) => !activeCategory || item.category_id === activeCategory) ?? [];
  const showRecords = !loading && (error === null || records.length > 0);
  return <div className="checkin-workspace">
    {message && <div key={successID} role="status" className={`checkin-notice ${successID && !session.account.preferences.reduce_motion ? 'checkin-celebrate' : ''}`}><p>{message}</p>{reward && <CheckinRewardFeedback key={reward.id} coins={reward.coin_reward_snapshot} diamonds={reward.diamond_reward_snapshot} reduceMotion={session.account.preferences.reduce_motion} />}</div>}
    {pending && <div className="checkin-warning"><p>{content.pendingBanner}</p>{pending.path.startsWith('/management') ? <p>{content.pendingManagement}</p> : <button onClick={() => setTask(pending.task)}>{content.recover}</button>}</div>}
    {!pending && draft && <div className="checkin-warning"><p>{content.draftAvailable}</p>{draft.management ? <p>{content.draftManagement}</p> : <button onClick={() => setTask(draft.task)}>{content.continueDraft}</button>}</div>}
    {error !== null && <div role="alert" className="checkin-error"><p>{checkinError(error)}</p><button className="secondary" onClick={() => refresh((value) => value + 1)}>{content.reload}</button></div>}
    <div className="checkin-layout">
      <section className="checkin-panel checkin-records-panel" aria-labelledby="checkin-records-heading">
        <h2 id="checkin-records-heading">{content.records}</h2>
        {loading && <p role="status">{content.loading}</p>}
        {showRecords && <RecordList records={records} onSelect={setSelected} />}
        {cursor && <div className="checkin-stack"><button disabled={loading || loadingMore} className="secondary" onClick={() => void loadMore()}>{loadingMore ? content.loading : content.more}</button></div>}
      </section>
      <section className="checkin-panel checkin-tasks-panel" aria-labelledby="checkin-tasks-heading"><h2 id="checkin-tasks-heading">{content.todayTasks}</h2>
        {camp && <ViewTabs label={content.category} items={categories} value={activeCategory} onChange={setCategory}>
          {visibleTasks.length === 0 ? <p className="checkin-empty">{!camp.has_scheduled_tasks ? content.noTasks : camp.tasks.length === 0 ? content.allDone : content.categoryDone}</p> : <div className="checkin-task-grid">{visibleTasks.map((item) => <button key={item.id} className="checkin-task secondary" disabled={pending !== null || draft !== null || loading || error !== null} onClick={() => setTask(item)}><TaskIcon name={item.icon_key} /><strong>{item.name}</strong><span className="checkin-rewards"><CurrencyAmount currency="coins" amount={item.coin_reward} /><CurrencyAmount currency="diamonds" amount={item.diamond_reward} /></span></button>)}</div>}
        </ViewTabs>}
      </section>
      <aside className="checkin-sidebar">{camp && renderSidebar?.(camp)}</aside>
    </div>
    {task && <CheckinComposer client={client} session={session} task={task} date={today} onClose={() => setTask(null)} onSaved={saved} />}
    {selected && <RecordDialog client={client} session={session} record={selected} today={today} onClose={() => setSelected(null)} onSaved={saved} />}
  </div>;
}
