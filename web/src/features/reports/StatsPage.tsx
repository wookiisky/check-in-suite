import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ApiClient } from '../../api/client';
import { monthStart, shiftDate, weekStart } from '../../api/dates';
import type { Session } from '../../api/types';
import type { components } from '../../api/schema';
import { FormFeedback } from '../../components/FormFeedback';
import { useBusinessToday } from './useBusinessToday';
import content from './content.json';
import './reports.css';

type Preset = 'week' | 'month' | 'last7' | 'last30' | 'custom';
type Stats = components['schemas']['StatsResponse'];

// 统计范围只采用服务端日历日期，包含起止两天。
function presetStart(preset: Preset, today: string): string {
  if (preset === 'week') return weekStart(today);
  if (preset === 'last7') return shiftDate(today, -6);
  if (preset === 'last30') return shiftDate(today, -29);
  return monthStart(today);
}

// 预设变化立即查询，自定义范围在明确提交且验证后查询。
export function StatsPage({ client, session }: { client: Pick<ApiClient, 'request'> & Partial<Pick<ApiClient, 'now'>>; session: Session }) {
  const today = useBusinessToday(client, session);
  const [preset, setPreset] = useState<Preset>('month');
  const [start, setStart] = useState(monthStart(today));
  const [end, setEnd] = useState(today);
  const [custom, setCustom] = useState({ start: monthStart(today), end: today });
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [validation, setValidation] = useState('');
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const rangeStart = preset === 'custom' ? custom.start : presetStart(preset, today);
  const rangeEnd = preset === 'custom' ? custom.end : today;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setData(null);
    client.request<Stats>(`/stats?start_date=${rangeStart}&end_date=${rangeEnd}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, rangeStart, rangeEnd, attempt, today]);

  // 非法范围不继续展示旧统计，避免被当作本次查询结果。
  function apply(event: FormEvent) {
    event.preventDefault();
    let message = '';
    if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) message = content.rangeRequired;
    else if (start > end) message = content.rangeOrder;
    else if (end > today) message = content.rangeFuture;
    else if ((Date.parse(end) - Date.parse(start)) / 86400000 + 1 > session.limits.stats_days_max) message = content.rangeTooLong;
    setValidation(message);
    if (message) return;
    setCustom({ start, end });
    setAttempt((value) => value + 1);
  }
  const maximum = Math.max(1, ...(data?.items.map((item) => item.count) ?? []));
  return <section className="panel reports-page">
    <h1>{content.stats}</h1>
    <label>{content.range}<select value={preset} onChange={(event) => { setPreset(event.target.value as Preset); setValidation(''); }}>{(['week', 'month', 'last7', 'last30', 'custom'] as const).map((item) => <option key={item} value={item}>{content[item]}</option>)}</select></label>
    {preset === 'custom' && <form className="reports-range" onSubmit={apply} noValidate><label>{content.start}<input type="date" value={start} max={today} onChange={(event) => setStart(event.target.value)} /></label><label>{content.end}<input type="date" value={end} max={today} onChange={(event) => setEnd(event.target.value)} /></label><button>{content.apply}</button></form>}
    {validation && <p className="form-error" role="alert">{validation}</p>}
    <FormFeedback error={error} />
    {error !== null && <button className="secondary" onClick={() => setAttempt((value) => value + 1)}>{content.retry}</button>}
    {loading && <p role="status">{content.loading}</p>}
    {data && !validation && <>
      <p className="muted">{data.start_date} — {data.end_date}</p>
      <dl className="reports-summary"><div><dt><img src="/api/v1/assets/star-v1" alt="" aria-hidden="true" />{content.total}</dt><dd>{data.total_count} {content.times}</dd></div><div><dt><img src="/api/v1/assets/calendar-v1" alt="" aria-hidden="true" />{content.activeDays}</dt><dd>{data.active_days} {content.days}</dd></div></dl>
      {data.items.length === 0 ? <p>{content.empty}</p> : <ol className="reports-bars">{data.items.map((item) => <li key={item.task_id}><div className="reports-bar-label"><img src={`/api/v1/assets/${encodeURIComponent(item.icon_key)}`} alt="" /><strong>{item.name}</strong><span>{item.count} {content.times}</span></div><div className="reports-track" aria-hidden="true"><span style={{ width: `${item.count / maximum * 100}%` }} /></div></li>)}</ol>}
    </>}
  </section>;
}
