import { useEffect, useRef, useState } from 'react';
import type { Checkin, CheckinPage, CheckinProps, Task } from './types';
import { CheckinComposer } from './CheckinComposer';
import { RecordDialog } from './RecordDialog';
import { RecordList } from './RecordList';
import { getPending } from './submission';
import { CREATE_DRAFT_KEY, getDraft } from './drafts';
import { checkinError } from './format';
import content from './content.json';

/** 纠正始终是删除和补录两个动作，删除成功后不会隐式补偿。 */
export function HistoryManagement({ client, session }: CheckinProps) {
  const [date, setDate] = useState(session.today);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskID, setTaskID] = useState('');
  const [draftText, setDraftText] = useState('');
  const [records, setRecords] = useState<Checkin[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState<Task | null>(null);
  const [selected, setSelected] = useState<Checkin | null>(null);
  const generation = useRef(0);
  const pending = getPending(client);
  const draft = getDraft(client, CREATE_DRAFT_KEY);

  useEffect(() => {
    let active = true;
    const currentGeneration = ++generation.current;
    setLoading(true); setError(null);
    void Promise.all([client.request<{ items: Task[] }>('/tasks?include_inactive=true'), client.request<CheckinPage>(`/checkins?${new URLSearchParams({ start_date: date, end_date: date })}`)])
      .then(([taskPage, page]) => {
        if (!active || currentGeneration !== generation.current) return;
        setTasks(taskPage.items.filter((task) => task.enabled)); setRecords(page.items); setCursor(page.next_cursor);
      }).catch((failure: unknown) => { if (active) setError(failure); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, date, revision]);

  // 补录列表的每一页都绑定当前日期，筛选变化后丢弃迟到结果。
  async function more() {
    if (!cursor || loading) return;
    const currentGeneration = generation.current;
    setLoading(true); setError(null);
    try {
      const page = await client.request<CheckinPage>(`/checkins?${new URLSearchParams({ start_date: date, end_date: date, cursor })}`);
      if (currentGeneration !== generation.current) return;
      setRecords((items) => [...items, ...page.items]); setCursor(page.next_cursor);
    } catch (failure) { if (currentGeneration === generation.current) setError(failure); }
    finally { if (currentGeneration === generation.current) setLoading(false); }
  }

  // 成功后的加载失败仅重试读取，保留新的补录草稿。
  function saved(notice: string) { setMessage(notice); refresh((value) => value + 1); }

  // 旧记录已删除，复制内容供用户选择正确日期与任务后重新确认。
  function correct(record: Checkin) {
    setDate(record.business_date); setTaskID(record.task_id); setDraftText(record.text); setMessage(content.correctionDeleted);
  }

  const chosenTask = tasks.find((task) => task.id === taskID) ?? tasks[0];
  return <div className="checkin-workspace">
    {message && <p role="status" className="checkin-notice">{message}</p>}
    {error !== null && <div role="alert" className="checkin-error"><p>{checkinError(error)}</p><button className="secondary" onClick={() => refresh((value) => value + 1)}>{content.reload}</button></div>}
    {pending && <div className="checkin-warning"><p>{content.pendingBanner}</p><button onClick={() => setCreating(pending.task)}>{content.recover}</button></div>}
    {!pending && draft && <div className="checkin-warning"><p>{content.draftAvailable}</p><button onClick={() => setCreating(draft.task)}>{content.continueDraft}</button></div>}
    <section className="checkin-panel checkin-stack"><h2>{content.manageRecords}</h2><label>{content.date}<input type="date" value={date} max={session.today} onChange={(event) => { if (event.target.value) setDate(event.target.value); }} /></label>
      {loading ? <p role="status">{content.loading}</p> : error === null && <RecordList records={records} management onSelect={setSelected} />}
      {cursor && <><p className="checkin-hint">{content.morePending}</p><button className="secondary" disabled={loading} onClick={() => void more()}>{content.more}</button></>}
    </section>
    <section className="checkin-panel checkin-stack"><h2>{content.backfillNew}</h2><p className="checkin-hint">{content.backfillWarning}</p>
      {tasks.length === 0 ? <p>{content.noEnabledTasks}</p> : <><label>{content.chooseTask}<select value={chosenTask?.id ?? ''} onChange={(event) => setTaskID(event.target.value)}>{tasks.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></label><button disabled={loading || !chosenTask || pending !== null || draft !== null} onClick={() => { if (chosenTask) setCreating(chosenTask); }}>{content.backfillNew}</button></>}
    </section>
    {creating && <CheckinComposer client={client} session={session} task={creating} date={date} initialText={draftText} management={pending ? pending.path.startsWith('/management') : draft ? draft.management : true} onClose={() => setCreating(null)} onSaved={(notice) => { setDraftText(''); saved(notice); }} />}
    {selected && <RecordDialog client={client} session={session} record={selected} today={session.today} management onClose={() => setSelected(null)} onSaved={saved} onCorrect={correct} />}
  </div>;
}
