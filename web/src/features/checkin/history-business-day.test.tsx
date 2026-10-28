import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { HistoryManagement } from './HistoryManagement';
import { taskFixture } from './test-fixtures';
import content from './content.json';

const session = testSession as Session;

describe('管理记录业务日期', () => {
  it('登录后跨日再进入管理，默认和日期上限都使用当前服务端日期', async () => {
    const request = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
    render(<HistoryManagement client={{ request, now: () => new Date('2026-10-30T04:00:00Z') }} session={session} />);
    await screen.findByText(content.noRecords);
    const date = screen.getByLabelText(content.date);
    expect(date).toHaveValue('2026-10-30');
    expect(date).toHaveAttribute('max', '2026-10-30');
    expect(request).toHaveBeenCalledWith('/checkins?start_date=2026-10-30&end_date=2026-10-30');
  });

  it.each(['midnight', 'visible'] as const)('%s 跨日只更新上限，保留所选历史日期和正在编辑的草稿', async (trigger) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T15:59:59Z'));
    const request = vi.fn().mockImplementation(async (path: string) => path.startsWith('/tasks') ? { items: [taskFixture] } : { items: [], next_cursor: null });
    const view = render(<HistoryManagement client={{ request, now: () => new Date(Date.now()) }} session={session} />);
    try {
      await act(async () => {});
      const date = screen.getByLabelText(content.date);
      fireEvent.change(date, { target: { value: '2026-10-28' } });
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: content.backfillNew }));
      fireEvent.change(screen.getByLabelText(content.text), { target: { value: '跨日保留的内容' } });
      const readCount = request.mock.calls.length;
      await act(async () => {
        if (trigger === 'midnight') vi.advanceTimersByTime(1001);
        else {
          vi.setSystemTime(new Date('2026-10-30T04:00:00Z'));
          fireEvent(document, new Event('visibilitychange'));
        }
      });
      expect(date).toHaveAttribute('max', '2026-10-30');
      expect(date).toHaveValue('2026-10-28');
      expect(screen.getByLabelText(content.text)).toHaveValue('跨日保留的内容');
      expect(within(screen.getByRole('dialog')).getByText(`${content.date}：2026-10-28`)).toBeInTheDocument();
      expect(request).toHaveBeenCalledTimes(readCount);
    } finally { view.unmount(); vi.useRealTimers(); }
  });
});
