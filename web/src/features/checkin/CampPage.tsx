import { CurrencyAmount } from '../../components/CurrencyAmount';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { shiftDate, weekStart } from '../../api/dates';
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

/** 日模式左侧记录和任务、右侧角色留言；周模式记录跨整页，侧栏保持挂载。 */
export function CampPage({ client, session, renderSidebar }: CheckinProps & { renderSidebar?: (camp: Camp) => ReactNode }) {
  const [camp, setCamp] = useState<Camp | null>(null);
  const [view, setView] = useState<'day' | 'week'>('day');
  const [date, setDate] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [records, setRecords] = useState<Checkin[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [successID, setSuccessID] = useState('');
  const [reward, setReward] = useState<{ record: Checkin; walletVersion: number | undefined } | null>(null);
  const [walletFeedbackID, setWalletFeedbackID] = useState('');
  const awaitingWalletFeedback = useRef(false);
  const [task, setTask] = useState<Task | null>(null);
  const [selected, setSelected] = useState<Checkin | null>(null);
  const generation = useRef(0);
  const animatedRecords = useRef(new Set<string>());
  const pending = getPending(client);
  const draft = getDraft(client, CREATE_DRAFT_KEY);
  const shownDate = date ?? camp?.today ?? session.today;
  const rangeStart = view === 'week' ? weekStart(shownDate) : shownDate;
  const rangeEnd = view === 'week' ? shiftDate(rangeStart, 6) : shownDate;
  const weekDates = Array.from({ length: 7 }, (_, day) => shiftDate(rangeStart, day));

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
        const selectedDate = date ?? snapshot.today;
        const start = view === 'week' ? weekStart(selectedDate) : selectedDate;
        const end = view === 'week' ? shiftDate(start, 6) : start;
        const page = await client.request<CheckinPage>(`/checkins?${new URLSearchParams({ start_date: start, end_date: end })}`);
        if (!active || generation.current !== requestGeneration) return;
        setRecords(page.items); setCursor(page.next_cursor);
      } catch (failure) { if (active) setError(failure); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [client, date, view, revision]);

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

  // 首次读到打卡后的余额就消费强调机会，后续普通读取不会重新播放。
  useEffect(() => {
    if (!awaitingWalletFeedback.current || !reward || camp?.wallet.version === reward.walletVersion) return;
    awaitingWalletFeedback.current = false;
    setWalletFeedbackID(reward.record.id);
  }, [camp, reward]);

  // 分页沿用当前日期范围，保留已加载内容，迟到响应不能混入新筛选。
  async function loadMore() {
    if (!cursor || loading || loadingMore) return;
    const requestGeneration = generation.current;
    setLoadingMore(true); setError(null);
    try {
      const page = await client.request<CheckinPage>(`/checkins?${new URLSearchParams({ start_date: rangeStart, end_date: rangeEnd, cursor })}`);
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
      setReward({ record, walletVersion: camp?.wallet.version });
      awaitingWalletFeedback.current = true;
      window.dispatchEvent(new CustomEvent<CheckinSuccessDetail>(CHECKIN_SUCCESS_EVENT, {
        detail: { recordId: record.id, coins: record.coin_reward_snapshot, diamonds: record.diamond_reward_snapshot },
      }));
    } else { setSuccessID(''); setReward(null); awaitingWalletFeedback.current = false; setWalletFeedbackID(''); }
    refresh((value) => value + 1);
  }

  const visibleTasks = camp?.tasks.filter((item) => !category || item.category_id === category) ?? [];
  const showRecords = !loading && (error === null || records.length > 0);
  const highlightWallet = walletFeedbackID !== '' && walletFeedbackID === successID && !session.account.preferences.reduce_motion;
  return <div className="checkin-workspace">
    {message && <div key={successID} role="status" className={`checkin-notice ${successID && !session.account.preferences.reduce_motion ? 'checkin-celebrate' : ''}`}><p>{message}</p>{reward && <CheckinRewardFeedback key={reward.record.id} coins={reward.record.coin_reward_snapshot} diamonds={reward.record.diamond_reward_snapshot} reduceMotion={session.account.preferences.reduce_motion} />}</div>}
    {pending && <div className="checkin-warning"><p>{content.pendingBanner}</p>{pending.path.startsWith('/management') ? <p>{content.pendingManagement}</p> : <button onClick={() => setTask(pending.task)}>{content.recover}</button>}</div>}
    {!pending && draft && <div className="checkin-warning"><p>{content.draftAvailable}</p>{draft.management ? <p>{content.draftManagement}</p> : <button onClick={() => setTask(draft.task)}>{content.continueDraft}</button>}</div>}
    {error !== null && <div role="alert" className="checkin-error"><p>{checkinError(error)}</p><button className="secondary" onClick={() => refresh((value) => value + 1)}>{content.reload}</button></div>}
    <div className={`checkin-layout checkin-${view}-layout`}>
      <section className="checkin-panel checkin-records-panel" aria-labelledby="checkin-records-heading">
        <div className="checkin-section-heading"><h2 id="checkin-records-heading">{content.records}</h2><div className="checkin-tabs" aria-label={content.viewLabel}><button className="secondary" aria-pressed={view === 'day'} onClick={() => setView('day')}>{content.dayView}</button><button className="secondary" aria-pressed={view === 'week'} onClick={() => setView('week')}>{content.weekView}</button></div></div>
        <p className="checkin-date-heading">{view === 'week' ? `${rangeStart} — ${rangeEnd}` : shownDate}</p>
        <div className="checkin-actions"><button className="secondary" onClick={() => setDate(shiftDate(shownDate, view === 'week' ? -7 : -1))}>{view === 'week' ? content.previousWeek : content.previousDay}</button><button className="secondary" onClick={() => setDate(null)}>{view === 'week' ? content.thisWeek : content.today}</button><button className="secondary" onClick={() => setDate(shiftDate(shownDate, view === 'week' ? 7 : 1))}>{view === 'week' ? content.nextWeek : content.nextDay}</button></div>
        {loading && <p role="status">{content.loading}</p>}
        {showRecords && (view === 'day' ? <RecordList records={records} onSelect={setSelected} /> : <div className="checkin-week-grid">{weekDates.map((day, index) => <section key={day} className={`checkin-week-day ${day === camp?.today ? 'is-today' : ''}`} aria-label={`${content.weekdays[index]} ${day}`}><h3>{content.weekdays[index]}<time dateTime={day}>{day}</time></h3>{day === camp?.today && <p className="checkin-today-label">{content.today}</p>}<RecordList records={records.filter((record) => record.business_date === day)} onSelect={setSelected} /></section>)}</div>)}
        {cursor && <div className="checkin-stack"><button disabled={loading || loadingMore} className="secondary" onClick={() => void loadMore()}>{loadingMore ? content.loading : content.more}</button></div>}
      </section>
      <section className="checkin-panel checkin-tasks-panel" aria-labelledby="checkin-tasks-heading"><h2 id="checkin-tasks-heading">{content.todayTasks}</h2>
        {camp && <>
          <select aria-label={content.category} value={category} onChange={(event) => setCategory(event.target.value)}><option value="">{content.allCategories}</option>{camp.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          {visibleTasks.length === 0 ? <p className="checkin-empty">{!camp.has_scheduled_tasks ? content.noTasks : camp.tasks.length === 0 ? content.allDone : content.categoryDone}</p> : <div className="checkin-task-grid">{visibleTasks.map((item) => <button key={item.id} className="checkin-task secondary" disabled={pending !== null || draft !== null || loading || error !== null} onClick={() => setTask(item)}><TaskIcon name={item.icon_key} /><strong>{item.name}</strong><span className="checkin-rewards"><CurrencyAmount currency="coins" amount={item.coin_reward} /><CurrencyAmount currency="diamonds" amount={item.diamond_reward} /></span></button>)}</div>}
        </>}
      </section>
      <aside className="checkin-sidebar"><section className="checkin-panel checkin-wallet" aria-label={content.balance}>{camp && <><CurrencyAmount currency="coins" amount={camp.wallet.coins}><strong key={`coins-${successID}`} className={highlightWallet ? 'feedback-pop' : undefined} onAnimationEnd={() => setWalletFeedbackID('')}>{camp.wallet.coins}</strong></CurrencyAmount><CurrencyAmount currency="diamonds" amount={camp.wallet.diamonds}><strong key={`diamonds-${successID}`} className={highlightWallet ? 'feedback-pop' : undefined} onAnimationEnd={() => setWalletFeedbackID('')}>{camp.wallet.diamonds}</strong></CurrencyAmount></>}</section>{camp && renderSidebar?.(camp)}</aside>
    </div>
    {task && <CheckinComposer client={client} session={session} task={task} date={camp?.today ?? session.today} onClose={() => setTask(null)} onSaved={saved} />}
    {selected && <RecordDialog client={client} session={session} record={selected} today={camp?.today ?? session.today} onClose={() => setSelected(null)} onSaved={saved} />}
  </div>;
}
