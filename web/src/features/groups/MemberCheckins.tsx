import { useEffect, useRef, useState } from 'react';
import { ApiFailure } from '../../api/client';
import type { Session } from '../../api/types';
import { FormFeedback } from '../../components/FormFeedback';
import { RecordDialog } from '../checkin/RecordDialog';
import { RecordList } from '../checkin/RecordList';
import { TaskIcon } from '../checkin/TaskIcon';
import type { Checkin, CheckinPage, CheckinClient } from '../checkin/types';
import { useBusinessToday } from '../reports/useBusinessToday';
import type { MemberToday } from './group-types';
import checkinContent from '../checkin/content.json';
import content from './content.json';

/** 同组打卡页只读取任务状态与记录，不取得其他成员的营地或钱包。 */
export function MemberCheckins({ client, session, accountID, onAccessDenied }: { client: CheckinClient; session: Session; accountID: number; onAccessDenied: () => void }) {
  const today = useBusinessToday(client, session);
  const [todayStatus, setTodayStatus] = useState<MemberToday | null>(null);
  const [records, setRecords] = useState<Checkin[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Checkin | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const pageRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingMore(false);
    setLoading(true); setError(null); setTodayStatus(null); setRecords([]); setCursor(null); setSelected(null);
    const query = new URLSearchParams({ start_date: today, end_date: today, account_id: String(accountID) });
    void Promise.all([
      client.request<MemberToday>(`/group-today?account_id=${accountID}`, { signal: controller.signal }),
      client.request<CheckinPage>(`/checkins?${query}`, { signal: controller.signal }),
    ]).then(([status, page]) => {
      if (!controller.signal.aborted) { setTodayStatus(status); setRecords(page.items); setCursor(page.next_cursor); }
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiFailure && (reason.status === 403 || reason.status === 404)) onAccessDenied();
      else setError(reason);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); pageRequest.current?.abort(); };
  }, [client, accountID, today, attempt, onAccessDenied]);

  // 追加页与当前成员、日期共用取消边界，切换后不能再追加旧记录。
  async function loadMore() {
    if (!cursor || loadingMore) return;
    pageRequest.current?.abort();
    const controller = new AbortController();
    pageRequest.current = controller;
    setLoadingMore(true); setError(null);
    try {
      const query = new URLSearchParams({ start_date: today, end_date: today, account_id: String(accountID), cursor });
      const page = await client.request<CheckinPage>(`/checkins?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setRecords((items) => [...items, ...page.items.filter((item) => !items.some((known) => known.id === item.id))]); setCursor(page.next_cursor);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiFailure && (reason.status === 403 || reason.status === 404)) onAccessDenied();
      else setError(reason);
    } finally { if (!controller.signal.aborted) setLoadingMore(false); }
  }
  return <div className="checkin-workspace">
    <FormFeedback error={error} />{error !== null && <button className="secondary" onClick={() => setAttempt((value) => value + 1)}>{content.retry}</button>}
    <section className="checkin-panel" aria-labelledby="member-records-heading">
      <h2 id="member-records-heading">{checkinContent.records}</h2>
      {loading && <p role="status">{content.loading}</p>}
      {!loading && (!error || records.length > 0) && <RecordList records={records} onSelect={setSelected} />}
      {cursor && <button className="secondary" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? content.loading : checkinContent.more}</button>}
    </section>
    <section className="checkin-panel" aria-labelledby="member-tasks-heading"><h2 id="member-tasks-heading">{checkinContent.todayTasks}</h2>
      {todayStatus && (todayStatus.tasks.length === 0 ? <p>{content.noTasks}</p> : <ul className="group-member-tasks">{todayStatus.tasks.map((task) => <li key={task.id}><TaskIcon name={task.icon_key} /><strong>{task.name}</strong><span>{content.completedSummary.replace('{completed}', String(task.completed)).replace('{limit}', String(task.daily_limit)).replace('{remaining}', String(task.remaining))}</span></li>)}</ul>)}
    </section>
    {selected && <RecordDialog key={selected.id} client={client} session={session} record={selected} today={today} readOnly onClose={() => setSelected(null)} onSaved={() => {}} />}
  </div>;
}
