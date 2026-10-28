import { useEffect, useRef, useState } from 'react';
import type { Camp, Checkin, CheckinPage, CheckinProps, Task } from './types';
import { CheckinComposer } from './CheckinComposer';
import { RecordDialog } from './RecordDialog';
import { RecordList } from './RecordList';
import { TaskIcon } from './TaskIcon';
import { getPending } from './submission';
import { checkinError, moveDate } from './format';
import content from './content.json';
import { CHECKIN_SUCCESS_EVENT } from './events';
import './checkin.css';

/** 读取与写入分离：写成功只刷新数据，不再发送同一业务。 */
export function CampPage({ client, session }: CheckinProps) {
  const [camp, setCamp] = useState<Camp | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [records, setRecords] = useState<Checkin[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [successID, setSuccessID] = useState('');
  const [task, setTask] = useState<Task | null>(null);
  const [selected, setSelected] = useState<Checkin | null>(null);
  const generation = useRef(0);
  const animatedRecords = useRef(new Set<string>());
  const pending = getPending(client);
  const shownDate = date ?? camp?.today ?? session.today;

  useEffect(() => {
    let active = true;
    const requestGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const snapshot = await client.request<Camp>('/camp');
        const selectedDate = date ?? snapshot.today;
        const page = await client.request<CheckinPage>(`/checkins?${new URLSearchParams({ start_date: selectedDate, end_date: selectedDate })}`);
        if (!active || generation.current !== requestGeneration) return;
        setCamp(snapshot); setRecords(page.items); setCursor(page.next_cursor);
      } catch (failure) { if (active) setError(failure); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [client, date, revision]);

  useEffect(() => {
    if (!camp) return;
    const offset = new Date(camp.server_now).getTime() - Date.now();
    const nextMidnight = new Date(`${moveDate(camp.today, 1)}T00:00:00+08:00`).getTime();
    const checkDay = () => {
      const serverDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset));
      if (serverDate !== camp.today) refresh((value) => value + 1);
    };
    const timer = window.setTimeout(checkDay, Math.max(100, nextMidnight - Date.now() - offset + 50));
    const visible = () => { if (document.visibilityState === 'visible') checkDay(); };
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [camp]);

  // 分页请求沿用当前筛选，迟到结果不会覆盖新日期。
  async function loadMore() {
    if (!cursor || loading) return;
    const requestGeneration = generation.current;
    setLoading(true); setError(null);
    try {
      const page = await client.request<CheckinPage>(`/checkins?${new URLSearchParams({ start_date: shownDate, end_date: shownDate, cursor })}`);
      if (generation.current !== requestGeneration) return;
      setRecords((items) => [...items, ...page.items.filter((item) => !items.some((known) => known.id === item.id))]);
      setCursor(page.next_cursor);
    } catch (failure) { if (generation.current === requestGeneration) setError(failure); }
    finally { if (generation.current === requestGeneration) setLoading(false); }
  }

  // 同一记录的幂等重放不重复播放成功反馈。
  function saved(notice: string, record?: Checkin, created = false) {
    setMessage(notice);
    if (created && record && !animatedRecords.current.has(record.id)) {
      setSuccessID(record.id);
      animatedRecords.current.add(record.id);
      window.dispatchEvent(new CustomEvent(CHECKIN_SUCCESS_EVENT, { detail: record.id }));
    } else setSuccessID('');
    refresh((value) => value + 1);
  }

  const visibleTasks = camp?.tasks.filter((item) => !category || item.category_id === category) ?? [];
  return <div className="checkin-workspace">
    {message && <p key={successID} role="status" className={`checkin-notice ${successID && !session.account.preferences.reduce_motion ? 'checkin-celebrate' : ''}`}>{message}</p>}
    {pending && <div className="checkin-warning"><p>{content.pendingBanner}</p>{pending.path.startsWith('/management') ? <p>{content.pendingManagement}</p> : <button onClick={() => setTask(pending.task)}>{content.recover}</button>}</div>}
    {error !== null && <div role="alert" className="checkin-error"><p>{checkinError(error)}</p><button className="secondary" onClick={() => refresh((value) => value + 1)}>{content.reload}</button></div>}
    <section className="checkin-panel" aria-labelledby="checkin-records-heading"><div className="checkin-section-heading"><h2 id="checkin-records-heading">{content.records}</h2><p>{shownDate}</p></div>
      <div className="checkin-actions"><button className="secondary" onClick={() => setDate(moveDate(shownDate, -1))}>{content.previousDay}</button><button className="secondary" onClick={() => setDate(null)}>{content.today}</button><button className="secondary" onClick={() => setDate(moveDate(shownDate, 1))}>{content.nextDay}</button></div>
      {shownDate !== (camp?.today ?? session.today) && <p className="checkin-hint">{content.historyReadOnly}</p>}
      {loading && <p role="status">{content.loading}</p>}
      {!loading && error === null && <RecordList records={records} onSelect={setSelected} />}
      {cursor && <div className="checkin-stack"><p className="checkin-hint">{content.morePending}</p><button disabled={loading} className="secondary" onClick={() => void loadMore()}>{content.more}</button></div>}
    </section>
    <div className="checkin-camp-columns"><section className="checkin-panel" aria-labelledby="checkin-tasks-heading"><h2 id="checkin-tasks-heading">{content.todayTasks}</h2>
      {camp && <>
        <label className="checkin-stack">{content.category}<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">{content.allCategories}</option>{camp.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {visibleTasks.length === 0 ? <p className="checkin-empty">{!camp.has_scheduled_tasks ? content.noTasks : camp.tasks.length === 0 ? content.allDone : content.categoryDone}</p> : <div className="checkin-task-grid">{visibleTasks.map((item) => <button key={item.id} className="checkin-task secondary" disabled={pending !== null || loading} onClick={() => setTask(item)}><TaskIcon name={item.icon_key} /><strong>{item.name}</strong><span className="checkin-rewards"><span>{content.coins} {item.coin_reward}</span><span>{content.diamonds} {item.diamond_reward}</span></span></button>)}</div>}
      </>}
    </section><aside className="checkin-panel checkin-wallet" aria-label={content.balance}>{camp && <><h2>{camp.account.display_name}</h2><p>{content.coins} <strong>{camp.wallet.coins}</strong></p><p>{content.diamonds} <strong>{camp.wallet.diamonds}</strong></p>{(camp.wallet.coins < 0 || camp.wallet.diamonds < 0) && <p className="checkin-hint">{content.negativeBalance}</p>}</>}</aside></div>
    {task && <CheckinComposer client={client} session={session} task={task} date={camp?.today ?? session.today} onClose={() => setTask(null)} onSaved={saved} />}
    {selected && <RecordDialog client={client} session={session} record={selected} today={camp?.today ?? session.today} onClose={() => setSelected(null)} onSaved={saved} />}
  </div>;
}
