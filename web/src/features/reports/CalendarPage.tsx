import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { monthEnd, shiftDate, weekStart } from '../../api/dates';
import type { Session } from '../../api/types';
import type { components } from '../../api/schema';
import { FormFeedback } from '../../components/FormFeedback';
import { Modal } from '../../components/Modal';
import { RecordDialog } from '../checkin/RecordDialog';
import { RecordList } from '../checkin/RecordList';
import '../checkin/checkin.css';
import type { Checkin, CheckinPage } from '../checkin/types';
import { useBusinessToday } from './useBusinessToday';
import content from './content.json';
import './reports.css';

type Calendar = components['schemas']['CalendarResponse'];

// 月份切换使用 UTC 日历，设备时区不参与日期计算。
function shiftMonth(month: string, offset: number): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

// 月历摘要和当日分页分别加载，查询失败不会把旧筛选内容当成新结果。
export function CalendarPage({ client, session }: { client: Pick<ApiClient, 'request'> & Partial<Pick<ApiClient, 'now'>>; session: Session }) {
  const today = useBusinessToday(client, session);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [calendar, setCalendar] = useState<Calendar | null>(null);
  const [calendarError, setCalendarError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [records, setRecords] = useState<Checkin[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [recordsError, setRecordsError] = useState<unknown>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [record, setRecord] = useState<Checkin | null>(null);
  const [notice, setNotice] = useState('');
  const detailRequest = useRef<AbortController | null>(null);
  const dateRef = useRef(selectedDate);
  dateRef.current = selectedDate;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setCalendar(null); setCalendarError(null);
    client.request<Calendar>(`/calendar?month=${month}`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setCalendar(value); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setCalendarError(reason); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, month, refresh, today]);

  // 分页追加前确认仍是同一个日期，关闭详情会取消所有在途读取。
  async function loadRecords(date: string, cursor: string | null = null) {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setRecordsLoading(true); setRecordsError(null);
    if (!cursor) { setRecords([]); setNextCursor(null); }
    try {
      const result = await client.request<CheckinPage>(`/checkins?start_date=${date}&end_date=${date}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal });
      if (controller.signal.aborted || dateRef.current !== date) return;
      setRecords((old) => cursor ? [...old, ...result.items.filter((item) => !old.some((existing) => existing.id === item.id))] : result.items);
      setNextCursor(result.next_cursor);
    } catch (reason) { if (!controller.signal.aborted) setRecordsError(reason); }
    finally { if (!controller.signal.aborted) setRecordsLoading(false); }
  }
  useEffect(() => {
    if (selectedDate) void loadRecords(selectedDate);
    return () => detailRequest.current?.abort();
  // loadRecords is intentionally driven only by date, writes and the business midnight.
  }, [selectedDate, client, refresh, today]);

  const first = `${month}-01`;
  const last = monthEnd(first);
  const cells: Array<string | null> = [];
  for (let day = weekStart(first); day < first; day = shiftDate(day, 1)) cells.push(null);
  for (let day = first; day <= last; day = shiftDate(day, 1)) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7));
  const summary = new Map(calendar?.days.map((day) => [day.date, day]));
  return <section className="panel reports-page">
    <h1>{content.calendar}</h1>
    <div className="calendar-toolbar"><strong>{month}</strong><button className="secondary" onClick={() => setMonth((value) => shiftMonth(value, -1))}>{content.previousMonth}</button><button className="secondary" onClick={() => setMonth((value) => shiftMonth(value, 1))}>{content.nextMonth}</button><button className="secondary" onClick={() => setMonth(today.slice(0, 7))}>{content.thisMonth}</button></div>
    {notice && <p role="status">{notice}</p>}
    <FormFeedback error={calendarError} />
    {calendarError !== null && <button className="secondary" onClick={() => setRefresh((value) => value + 1)}>{content.retry}</button>}
    {loading && <p role="status">{content.loading}</p>}
    {calendar && <><div className="calendar-weekdays" aria-hidden="true">{content.weekdays.map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-weeks">{weeks.map((week, index) => <div className="calendar-week" key={`${month}-${index}`}>{week.map((day, dayIndex) => {
      if (!day) return <span className="calendar-blank" key={`blank-${dayIndex}`} aria-hidden="true" />;
      const item = summary.get(day);
      return <button className="calendar-day" data-today={day === today} key={day} aria-label={`${day} ${content.weekdays[dayIndex]} ${item?.count ?? 0} ${content.count}${day === today ? ` ${content.today}` : ''}`} onClick={(event) => { event.currentTarget.focus(); setRecords([]); setNextCursor(null); setRecordsError(null); setSelectedDate(day); }}><time dateTime={day}>{Number(day.slice(-2))} · {content.weekdays[dayIndex]}</time>{day === today && <span className="calendar-day-today">{content.today}</span>}<span className="calendar-day-count">{item?.count ?? 0} {content.count}</span><span className="calendar-icons" aria-hidden="true">{item?.icons.map((icon, position) => <img key={`${icon}-${position}`} src={`/api/v1/assets/${encodeURIComponent(icon)}`} alt="" />)}{(item?.more_count ?? 0) > 0 && <span>+{item?.more_count}</span>}</span></button>;
    })}</div>)}</div></>}
    {selectedDate && !record && <Modal title={`${selectedDate} · ${content.dateDetail}`} onClose={() => setSelectedDate(null)}><div className="calendar-detail">
      {selectedDate < today && <p className="muted">{content.readOnly}</p>}{selectedDate > today && <p className="muted">{content.future}</p>}
      <FormFeedback error={recordsError} />{recordsError !== null && <button className="secondary" onClick={() => void loadRecords(selectedDate, nextCursor)}>{content.retry}</button>}
      {records.length > 0 && <RecordList records={records} onSelect={setRecord} />}
      {!recordsLoading && !recordsError && records.length === 0 && !nextCursor && <p>{content.empty}</p>}
      {recordsLoading && <p role="status">{content.loading}</p>}{nextCursor && <><p className="muted">{content.incomplete}</p><button className="secondary" disabled={recordsLoading} onClick={() => void loadRecords(selectedDate, nextCursor)}>{content.loadMore}</button></>}
    </div></Modal>}
    {record && <RecordDialog client={client} session={session} record={record} today={today} onClose={() => setRecord(null)} onSaved={(message) => { setNotice(message); setRefresh((value) => value + 1); }} />}
  </section>;
}
