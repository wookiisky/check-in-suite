import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { CampPage } from './CampPage';
import { campFixture, recordFixture } from './test-fixtures';
import content from './content.json';

const session = testSession as Session;

describe('营地日周查询与侧栏', () => {
  it('周视图查询完整周一至周日，七个日期包含空日都直接展示', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path === '/camp' ? campFixture : { items: [recordFixture], next_cursor: null });
    render(<CampPage client={{ request }} session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: content.weekView }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining('start_date=2026-10-26&end_date=2026-11-01')));
    await waitFor(() => expect(screen.queryByText(content.loading)).not.toBeInTheDocument());
    for (const [day, label] of ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'].map((day, index) => [day, content.weekdays[index]])) {
      expect(screen.getByRole('region', { name: `${label} ${day}` })).toBeInTheDocument();
    }
    const thursday = screen.getByRole('region', { name: `${content.weekdays[3]} 2026-10-29` });
    expect(within(thursday).getByRole('button', { name: /阅读/ })).toBeInTheDocument();
    expect(screen.getAllByText(content.noRecords)).toHaveLength(6);
  });

  it('周查询继续分页，加载期间保留已加载记录与侧栏草稿', async () => {
    let resolveMore: (value: unknown) => void = () => {};
    const more = new Promise((resolve) => { resolveMore = resolve; });
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return campFixture;
      if (path.includes('cursor=')) return more;
      return { items: [recordFixture], next_cursor: 'page-two' };
    });
    render(<CampPage client={{ request }} session={session} renderSidebar={() => <label>side-draft<input /></label>} />);
    fireEvent.change(await screen.findByLabelText('side-draft'), { target: { value: '不会丢失' } });
    fireEvent.click(screen.getByRole('button', { name: content.weekView }));
    await screen.findByRole('region', { name: `${content.weekdays[3]} 2026-10-29` });
    await waitFor(() => expect(screen.queryByText(content.loading)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: content.more }));
    expect(within(screen.getByRole('region', { name: `${content.weekdays[3]} 2026-10-29` })).getByRole('button', { name: /阅读/ })).toBeInTheDocument();
    expect(screen.getByLabelText('side-draft')).toHaveValue('不会丢失');
    resolveMore({ items: [{ ...recordFixture, id: 'record-2', business_date: '2026-10-30', task_name_snapshot: '第二页任务' }], next_cursor: null });
    await screen.findByRole('button', { name: /第二页任务/ });
    expect(screen.queryByText(content.morePending)).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(expect.stringContaining('start_date=2026-10-26&end_date=2026-11-01&cursor=page-two'));
  });

  it('真实营地响应校准共享时钟，聚焦和未跨日可见不会额外读取', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path === '/camp' ? campFixture : { items: [], next_cursor: null });
    const recordServerTime = vi.fn();
    const now = () => new Date(campFixture.server_now);
    render(<CampPage client={{ request, recordServerTime, now }} session={session} />);
    await screen.findByText(content.noRecords);
    expect(recordServerTime).toHaveBeenCalledWith(campFixture.server_now);
    const before = request.mock.calls.length;
    fireEvent.focus(window);
    fireEvent(document, new Event('visibilitychange'));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(before);
  });
});
