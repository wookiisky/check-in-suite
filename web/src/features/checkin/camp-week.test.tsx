import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { CampPage } from './CampPage';
import { campFixture, recordFixture, taskFixture } from './test-fixtures';
import type { Camp } from './types';
import content from './content.json';

const session = testSession as Session;

describe('今日打卡查询与侧栏', () => {
  it('只查询服务端今天的完成记录，没有日周切换或前后日期导航', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path === '/camp' ? campFixture : { items: [recordFixture], next_cursor: null });
    render(<CampPage client={{ request }} session={session} />);
    const records = await screen.findByRole('region', { name: content.records });
    expect(await within(records).findByRole('button', { name: /阅读/ })).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('/checkins?start_date=2026-10-29&end_date=2026-10-29');
    expect(screen.queryByRole('button', { name: '周视图' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '前一天' })).not.toBeInTheDocument();
  });

  it('任务分类以标签切换，默认包含无分类任务，且保留记录与侧栏输入', async () => {
    const category = { id: 'sports', name: '运动', sort_order: 1, version: 1 };
    const request = vi.fn().mockImplementation(async (path: string) => path === '/camp'
      ? { ...campFixture, categories: [category], tasks: [...campFixture.tasks, { ...taskFixture, id: 'running', category_id: category.id, name: '跑步' }] }
      : { items: [recordFixture], next_cursor: null });
    render(<CampPage client={{ request }} session={session} renderSidebar={() => <label>side-draft<input /></label>} />);
    const all = await screen.findByRole('tab', { name: content.allCategories });
    const sports = screen.getByRole('tab', { name: category.name });
    expect(all).toHaveAttribute('aria-selected', 'true');
    const tasks = screen.getByRole('region', { name: content.todayTasks });
    expect(within(tasks).getByRole('button', { name: /阅读/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('side-draft'), { target: { value: '不会丢失' } });
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(sports).toHaveFocus();
    expect(sports).toHaveAttribute('aria-selected', 'true');
    expect(within(tasks).getByRole('button', { name: /跑步/ })).toBeInTheDocument();
    expect(within(tasks).queryByRole('button', { name: /阅读/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: content.records })).getByRole('button', { name: /阅读/ })).toBeInTheDocument();
    expect(screen.getByLabelText('side-draft')).toHaveValue('不会丢失');
    expect(request).toHaveBeenCalledTimes(2);
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

  it('跨日刷新后显示新快照中的佩戴文本', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T15:59:59Z'));
    const oldTitle = { id: 'old', name: '原佩戴文本' };
    const newTitle = { id: 'new', name: '新佩戴文本' };
    let completeFresh!: (snapshot: Camp) => void;
    const fresh = new Promise<Camp>((resolve) => { completeFresh = resolve; });
    const campRead = vi.fn().mockResolvedValueOnce({ ...campFixture, server_now: new Date().toISOString(), achievement_title: oldTitle })
      .mockReturnValueOnce(fresh);
    const request = vi.fn().mockImplementation((path: string) => path === '/camp' ? campRead() : Promise.resolve({ items: [], next_cursor: null }));
    const view = render(<CampPage client={{ request, now: () => new Date() }} session={session} renderSidebar={(camp) => <output>{camp.achievement_title?.name}</output>} />);
    try {
      await act(async () => {});
      expect(screen.getByText(oldTitle.name)).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTime(1051));
      expect(campRead).toHaveBeenCalledTimes(2);
      const nextDay = { ...campFixture, today: '2026-10-30', server_now: new Date().toISOString() };
      await act(async () => completeFresh({ ...nextDay, achievement_title: newTitle }));
      expect(screen.queryByText(oldTitle.name)).not.toBeInTheDocument();
      expect(screen.getByText(newTitle.name)).toBeInTheDocument();
      expect(request).toHaveBeenLastCalledWith('/checkins?start_date=2026-10-30&end_date=2026-10-30');
    } finally { view.unmount(); vi.useRealTimers(); }
  });
});
