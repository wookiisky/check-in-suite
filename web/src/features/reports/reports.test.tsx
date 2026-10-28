import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CalendarPage } from './CalendarPage';
import { StatsPage } from './StatsPage';
import { recordFixture } from '../checkin/test-fixtures';
import { testSession } from '../../test/account-fixtures';
import type { Session } from '../../api/types';
const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

const emptyStats = { start_date: '2026-10-01', end_date: '2026-10-29', total_count: 0, active_days: 0, items: [] };

describe('查询页面', () => {
  it('统计默认按服务端本月至今天查询，非法范围不发请求', async () => {
    const request = vi.fn().mockResolvedValue(emptyStats);
    render(<StatsPage client={{ request }} session={session} />);
    await screen.findByText('还没有打卡记录');
    expect(request.mock.calls[0]?.[0]).toBe('/stats?start_date=2026-10-01&end_date=2026-10-29');
    fireEvent.change(screen.getByLabelText('统计范围'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-11-01' } });
    fireEvent.click(screen.getByRole('button', { name: '查看统计' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('开始日期不能晚于结束日期');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('切换统计范围后忽略迟到的旧响应', async () => {
    let finishOld!: (value: unknown) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce({ ...emptyStats, total_count: 2, active_days: 1, items: [{ task_id: 'new', name: '新的统计', icon_key: 'book-v1', count: 2 }] });
    render(<StatsPage client={{ request }} session={session} />);
    fireEvent.change(screen.getByLabelText('统计范围'), { target: { value: 'week' } });
    await screen.findByText('新的统计');
    finishOld({ ...emptyStats, items: [{ task_id: 'old', name: '旧的统计', icon_key: 'book-v1', count: 1 }] });
    await waitFor(() => expect(screen.queryByText('旧的统计')).not.toBeInTheDocument());
  });

  it('月历包含空日期，日期详情明确显示尚未加载完并继续分页', async () => {
    const request = vi.fn().mockImplementation((path: string) => {
      if (path.startsWith('/calendar')) return Promise.resolve({ month: '2026-10', days: [{ date: '2026-10-29', count: 2, icons: ['book-v1'], more_count: 0 }] });
      return Promise.resolve({ items: [], next_cursor: path.includes('cursor=') ? null : 'next-page' });
    });
    render(<CalendarPage client={{ request }} session={session} />);
    const day = await screen.findByRole('button', { name: /2026-10-29/ });
    expect(screen.getByRole('button', { name: /2026-10-01/ })).toBeInTheDocument();
    fireEvent.click(day);
    await screen.findByText('还有记录尚未加载');
    fireEvent.click(screen.getByRole('button', { name: '加载更多记录' }));
    await waitFor(() => expect(screen.queryByText('还有记录尚未加载')).not.toBeInTheDocument());
    expect(request).toHaveBeenLastCalledWith('/checkins?start_date=2026-10-29&end_date=2026-10-29&cursor=next-page', expect.anything());
  });
});

it('切页沿用已推进的服务端时钟，后台恢复未跨日不重新读取', async () => {
  const request = vi.fn().mockResolvedValue({ ...emptyStats, end_date: '2026-10-30' });
  const client = { request, now: () => new Date('2026-10-30T04:00:00Z') };
  render(<StatsPage client={client} session={session} />);
  await screen.findByText('还没有打卡记录');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[0]).toBe('/stats?start_date=2026-10-01&end_date=2026-10-30');
  fireEvent(document, new Event('visibilitychange'));
  fireEvent(window, new Event('focus'));
  fireEvent(window, new Event('online'));
  expect(request).toHaveBeenCalledTimes(1);
});

it('台北跨日后刷新统计截止日，设备时间只作为已校准时钟输入', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T15:59:59Z'));
  const request = vi.fn().mockResolvedValue(emptyStats);
  const client = { request, now: () => new Date(Date.now()) };
  const view = render(<StatsPage client={client} session={session} />);
  try {
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1001); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toBe('/stats?start_date=2026-10-01&end_date=2026-10-30');
  } finally { view.unmount(); vi.useRealTimers(); }
});

it('历史日期详情保留时间及附件线索，不展示奖励或普通编辑动作', async () => {
  const record = { ...recordFixture, business_date: '2026-10-28', can_edit: false, can_delete: false, photo_media_id: 'photo', audio_media_id: 'audio' };
  const request = vi.fn().mockImplementation((path: string) => Promise.resolve(path.startsWith('/calendar') ? { month: '2026-10', days: [{ date: record.business_date, count: 1, icons: ['book-v1'], more_count: 0 }] } : { items: [record], next_cursor: null }));
  render(<CalendarPage client={{ request }} session={session} />);
  fireEvent.click(await screen.findByRole('button', { name: /2026-10-28/ }));
  fireEvent.click(await screen.findByRole('button', { name: /阅读/ }));
  expect(screen.getByText('原始文字')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: '照片' })).toHaveAttribute('src', '/api/v1/media/photo');
  expect(screen.queryByRole('button', { name: '编辑内容' })).not.toBeInTheDocument();
  expect(screen.queryByText(/金币/)).not.toBeInTheDocument();
});
