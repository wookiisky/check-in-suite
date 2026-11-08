import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../api/client';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { recordFixture } from '../checkin/test-fixtures';
import type { CheckinPage } from '../checkin/types';
import { RecordDialog } from '../checkin/RecordDialog';
import { StatsPage } from '../reports/StatsPage';
import { GroupBrowse } from './GroupBrowse';
import { GroupManagement } from './GroupManagement';
import { MemberCheckins } from './MemberCheckins';

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };
const grouped = { groups: [{ id: 1, name: '一起成长' }], current_group: { id: 1, name: '一起成长' }, members: [{ id: 1, display_name: testSession.account.display_name }, { id: 2, display_name: '小雨' }, { id: 3, display_name: '小明' }] };
const emptyStats = { start_date: '2026-10-01', end_date: testSession.today, total_count: 0, active_days: 0, items: [] };

describe('组与成员查看', () => {
  it('加入组需当次管理密码，错误后保留选择，成功后清空密码', async () => {
    const request = vi.fn().mockResolvedValueOnce({ ...grouped, current_group: null, members: [] })
      .mockRejectedValueOnce(new ApiFailure(422, { code: 'INVALID_CREDENTIALS', field_errors: {}, request_id: '' }))
      .mockResolvedValueOnce(grouped);
    render(<GroupManagement client={{ request }} />);
    fireEvent.change(await screen.findByLabelText('已有组'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('管理密码'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: '加入组' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('已有组')).toHaveValue('1');
    fireEvent.change(screen.getByLabelText('管理密码'), { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: '加入组' }));
    await screen.findByRole('button', { name: '退出组' });
    expect(screen.getByLabelText('管理密码')).toHaveValue('');
    expect(request).toHaveBeenLastCalledWith('/groups/join', expect.objectContaining({ method: 'POST', body: { group_id: 1, password: 'correct-password' } }));
  });

  it('成员切换取消旧统计读取，迟到响应不能混入当前成员', async () => {
    let finishOld!: (value: unknown) => void;
    let oldSignal: AbortSignal | undefined;
    const request = vi.fn().mockImplementation((path: string, options?: { signal?: AbortSignal }) => {
      if (path === '/groups') return Promise.resolve(grouped);
      if (path.endsWith('account_id=2')) { oldSignal = options?.signal; return new Promise((resolve) => { finishOld = resolve; }); }
      return Promise.resolve({ ...emptyStats, items: path.endsWith('account_id=3') ? [{ task_id: 'member-3', name: '小明的任务', icon_key: 'book-v1', count: 1 }] : [] });
    });
    render(<GroupBrowse client={{ request }} session={session}>{(accountID, onAccessDenied) => <StatsPage client={{ request }} session={session} accountID={accountID} onAccessDenied={onAccessDenied} />}</GroupBrowse>);
    fireEvent.change(await screen.findByLabelText('查看成员'), { target: { value: '2' } });
    await waitFor(() => expect(oldSignal).toBeDefined());
    fireEvent.change(screen.getByLabelText('查看成员'), { target: { value: '3' } });
    await screen.findByText('小明的任务');
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => finishOld({ ...emptyStats, items: [{ task_id: 'member-2', name: '小雨旧任务', icon_key: 'book-v1', count: 5 }] }));
    expect(screen.queryByText('小雨旧任务')).not.toBeInTheDocument();
  });

  it('成员查看被拒绝时清除成员页面并刷新组状态', async () => {
    const request = vi.fn().mockImplementation((path: string) => {
      if (path === '/groups') return Promise.resolve(grouped);
      if (path.includes('account_id=2')) return Promise.reject(new ApiFailure(403, { code: 'GROUP_ACCESS_DENIED', field_errors: {}, request_id: '' }));
      return Promise.resolve(emptyStats);
    });
    render(<GroupBrowse client={{ request }} session={session}>{(accountID, onAccessDenied) => <StatsPage client={{ request }} session={session} accountID={accountID} onAccessDenied={onAccessDenied} />}</GroupBrowse>);
    fireEvent.change(await screen.findByLabelText('查看成员'), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByLabelText('查看成员')).toHaveValue('1'));
    expect(request.mock.calls.filter(([path]) => path === '/groups')).toHaveLength(2);
  });

  it('成员今日情况包含已完成任务，记录详情始终只读且不加载本人营地', async () => {
    const request = vi.fn().mockImplementation((path: string) => Promise.resolve(path.startsWith('/group-today') ? { today: testSession.today, tasks: [{ id: 'done', name: '跑步', icon_key: 'ball-v1', daily_limit: 2, completed: 2, remaining: 0 }] } : { items: [{ ...recordFixture, task_name_snapshot: '跑步记录' }], next_cursor: null }));
    render(<MemberCheckins client={{ request }} session={session} accountID={2} onAccessDenied={vi.fn()} />);
    expect(await screen.findByText('跑步')).toBeInTheDocument();
    expect(screen.getByText('已完成 2 / 2，剩余 0')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /跑步记录/ }));
    expect(screen.getByText('原始文字')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: '编辑内容' })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('/checkins?start_date=2026-10-29&end_date=2026-10-29&account_id=2', expect.anything());
    expect(screen.queryByRole('button', { name: '周视图' })).not.toBeInTheDocument();
    expect(request.mock.calls.every(([path]) => path !== '/camp')).toBe(true);
  });

  it('只读详情不受今日编辑标记影响，也不提供删除', () => {
    render(<RecordDialog client={{ request: vi.fn() }} session={session} record={recordFixture} today={testSession.today} readOnly onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '编辑内容' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除记录' })).not.toBeInTheDocument();
  });

  it.each(['success', 'abort'])('分页中切换成员后可继续分页，旧请求不能影响新查询（%s）', async (lateResult) => {
    let oldSignal: AbortSignal | undefined;
    let finishOld!: (page: CheckinPage) => void;
    let rejectOld!: (reason: unknown) => void;
    let finishNew!: (page: CheckinPage) => void;
    const oldPage = new Promise<CheckinPage>((resolve, reject) => { finishOld = resolve; rejectOld = reject; });
    const newPage = new Promise<CheckinPage>((resolve) => { finishNew = resolve; });
    const request = vi.fn().mockImplementation((path: string, options?: { signal?: AbortSignal }) => {
      if (path.startsWith('/group-today')) return Promise.resolve({ today: session.today, tasks: [] });
      const query = new URL(path, 'http://localhost').searchParams;
      if (query.get('cursor') === 'old-next') { oldSignal = options?.signal; return oldPage; }
      if (query.get('cursor') === 'new-next') return newPage;
      const initial = query.get('account_id') === '2';
      return Promise.resolve({
        items: [{ ...recordFixture, id: initial ? 'old-first' : 'new-first', business_date: query.get('start_date')!, task_name_snapshot: initial ? '原日期记录' : '新日期记录' }],
        next_cursor: initial ? 'old-next' : 'new-next',
      });
    });
    const onAccessDenied = vi.fn();
    const client = { request };
    const { rerender } = render(<MemberCheckins client={client} session={session} accountID={2} onAccessDenied={onAccessDenied} />);
    fireEvent.click(await screen.findByRole('button', { name: '加载更多记录' }));
    expect(oldSignal?.aborted).toBe(false);
    rerender(<MemberCheckins client={client} session={session} accountID={3} onAccessDenied={onAccessDenied} />);
    await screen.findByRole('button', { name: /新日期记录/ });
    expect(oldSignal?.aborted).toBe(true);
    const more = screen.getByRole('button', { name: /加载更多记录|正在加载…/ });
    expect(more).toBeEnabled();

    fireEvent.click(more);
    expect(more).toBeDisabled();
    await act(async () => {
      if (lateResult === 'success') finishOld({ items: [{ ...recordFixture, id: 'old-late', task_name_snapshot: '旧分页记录' }], next_cursor: null });
      else rejectOld(new DOMException('Aborted', 'AbortError'));
    });
    expect(more).toBeDisabled();
    expect(screen.queryByRole('button', { name: /旧分页记录/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => finishNew({ items: [{ ...recordFixture, id: 'new-last', business_date: session.today, task_name_snapshot: '新分页记录' }], next_cursor: null }));
    expect(screen.getByRole('button', { name: /新分页记录/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加载更多记录' })).not.toBeInTheDocument();
    expect(onAccessDenied).not.toHaveBeenCalled();
  });
});
