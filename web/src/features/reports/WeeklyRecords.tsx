import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure } from '../../api/client';
import { shiftDate, weekStart } from '../../api/dates';
import { FormFeedback } from '../../components/FormFeedback';
import { RecordDialog } from '../checkin/RecordDialog';
import { RecordList } from '../checkin/RecordList';
import type { Checkin, CheckinPage } from '../checkin/types';
import type { ReportsProps } from './ReportsPage';
import { useBusinessToday } from './useBusinessToday';
import content from './content.json';

// 周列表和记录详情共用成员授权，切换日期或成员即取消旧请求。
export function WeeklyRecords({ client, session, accountID = session.account.id, onAccessDenied }: ReportsProps) {
  const today = useBusinessToday(client, session);
  const readOnly = accountID !== session.account.id;
  const [date, setDate] = useState<string | null>(null);
  const [records, setRecords] = useState<Checkin[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Checkin | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [revision, refresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  const start = weekStart(date ?? today);
  const end = shiftDate(start, 6);

  // 失败的追加页保留已有记录和游标，重试继续读同一页。
  const load = useCallback(async (after: string | null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    if (!after) { setRecords([]); setCursor(null); }
    try {
      const query = new URLSearchParams({ start_date: start, end_date: end });
      if (readOnly) query.set('account_id', String(accountID));
      if (after) query.set('cursor', after);
      const page = await client.request<CheckinPage>(`/checkins?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setRecords((items) => after ? [...items, ...page.items.filter((item) => !items.some((known) => known.id === item.id))] : page.items);
      setCursor(page.next_cursor);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (readOnly && reason instanceof ApiFailure && (reason.status === 403 || reason.status === 404)) {
        setRecords([]); setCursor(null); setSelected(null);
        onAccessDenied?.();
      } else setError(reason);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [accountID, client, end, onAccessDenied, readOnly, start]);

  // 主动换周或换成员才关闭详情；台北跨日自动重读时保留正在编辑的记录。
  useEffect(() => { setSelected(null); }, [accountID, date]);
  useEffect(() => {
    void load(null);
    return () => request.current?.abort();
  }, [load, revision, today]);

  return <section className="panel reports-page">
    <h1>{content.weekView}</h1>
    <div className="calendar-toolbar">
      <strong>{start} — {end}</strong>
      <button type="button" className="secondary" onClick={() => setDate(shiftDate(start, -7))}>{content.previousWeek}</button>
      <button type="button" className="secondary" onClick={() => setDate(shiftDate(start, 7))}>{content.nextWeek}</button>
      <button type="button" className="secondary" onClick={() => setDate(null)}>{content.week}</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    <FormFeedback error={error} />
    {error !== null && <button type="button" className="secondary" onClick={() => void load(cursor)}>{content.retry}</button>}
    {loading && <p role="status">{content.loading}</p>}
    {((!loading && error === null) || records.length > 0 || cursor) && <div className="reports-week-grid">
      {content.weekdays.map((weekday, index) => {
        const day = shiftDate(start, index);
        return <section className="reports-week-day" data-today={day === today} key={day} aria-label={`${weekday} ${day}`}>
          <h2>{weekday}<time dateTime={day}>{day}</time></h2>
          <RecordList records={records.filter((record) => record.business_date === day)} onSelect={setSelected} showText />
        </section>;
      })}
    </div>}
    {cursor && error === null && <button type="button" className="secondary" disabled={loading} onClick={() => void load(cursor)}>{content.loadMore}</button>}
    {selected && <RecordDialog
      client={client}
      session={session}
      record={selected}
      today={today}
      readOnly={readOnly}
      onClose={() => setSelected(null)}
      onSaved={(message) => { setNotice(message); refresh((value) => value + 1); }}
    />}
  </section>;
}
