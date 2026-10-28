import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../api/client';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { CheckinComposer } from './CheckinComposer';
import { RecordDialog } from './RecordDialog';
import { CampPage } from './CampPage';
import { CheckinManagement } from './CheckinManagement';
import { campFixture, recordFixture, taskFixture } from './test-fixtures';
import content from './content.json';

const session = testSession as Session;
const result = { checkin: recordFixture, wallet: { coins: 2, diamonds: 1, version: 2 }, task_remaining: 1, today: '2026-10-29' };

describe('打卡与记录界面', () => {
  it('允许空文字新增，成功后刷新回调与提交分开', async () => {
    const request = vi.fn().mockResolvedValue(result);
    const saved = vi.fn();
    render(<CheckinComposer client={{ request }} session={session} task={taskFixture} date={session.today} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.click(screen.getByRole('button', { name: content.checkin }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(content.success, recordFixture, true));
    expect(request.mock.calls[0]?.[1].body).toEqual({ task_id: taskFixture.id, expected_task_version: 1, expected_today: session.today, text: '', photo_media_id: null, audio_media_id: null });
  });

  it('响应丢失后修改草稿，先恢复原命令再编辑原记录', async () => {
    const request = vi.fn().mockRejectedValueOnce(new ApiFailure(0, { code: 'NETWORK_ERROR', field_errors: {}, request_id: '' })).mockResolvedValueOnce(result).mockResolvedValueOnce({ ...recordFixture, text: '后来修改', version: 2 });
    render(<CheckinComposer client={{ request }} session={session} task={taskFixture} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.text), { target: { value: '原始文字' } });
    fireEvent.click(screen.getByRole('button', { name: content.checkin }));
    await screen.findByText(content.unknownResult);
    fireEvent.change(screen.getByLabelText(content.text), { target: { value: '后来修改' } });
    fireEvent.click(screen.getByRole('button', { name: content.recover }));
    await screen.findByText(content.resolvedEdit);
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
    expect(screen.queryByText(`${content.coins} 2`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[2]?.[0]).toBe('/checkins/record-1');
    expect(request.mock.calls[2]?.[1]).toMatchObject({ method: 'PATCH', body: { text: '后来修改', expected_version: 1 } });
  });

  it('普通历史详情隐藏奖励且不能编辑，删除确认才展示今日回收金额', async () => {
    const client = { request: vi.fn() };
    const view = render(<RecordDialog client={client} session={session} record={recordFixture} today="2026-10-30" onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('button', { name: content.edit })).not.toBeInTheDocument();
    expect(screen.queryByText(`${content.coins} 2`)).not.toBeInTheDocument();
    view.rerender(<RecordDialog client={client} session={session} record={recordFixture} today={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: content.delete }));
    expect(screen.getByText(`${content.coins} −2`)).toBeInTheDocument();
  });

  it('重放已经删除的记录不会转成编辑或再次发奖', async () => {
    const saved = vi.fn();
    const request = vi.fn().mockResolvedValue({ ...result, checkin: { ...recordFixture, deleted: true, text: '' } });
    render(<CheckinComposer client={{ request }} session={session} task={taskFixture} date={session.today} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.click(screen.getByRole('button', { name: content.checkin }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(content.resolvedDeleted));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('营地区分未安排任务和全部完成，不显示伪造记录', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path === '/camp' ? { ...campFixture, tasks: [], has_scheduled_tasks: false } : { items: [], next_cursor: null });
    const view = render(<CampPage client={{ request }} session={session} />);
    await screen.findByText(content.noTasks);
    expect(screen.getByText(content.noRecords)).toBeInTheDocument();
    view.unmount();
    const finished = vi.fn().mockImplementation(async (path: string) => path === '/camp' ? { ...campFixture, tasks: [] } : { items: [], next_cursor: null });
    render(<CampPage client={{ request: finished }} session={session} />);
    await screen.findByText(content.allDone);
  });

  it('浏览历史仍使用今天的任务日期，任务卡不显示次数和描述', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path === '/camp' ? campFixture : { items: [], next_cursor: null });
    render(<CampPage client={{ request }} session={session} />);
    await screen.findByRole('button', { name: /阅读/ });
    fireEvent.click(screen.getByRole('button', { name: content.previousDay }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining('start_date=2026-10-28')));
    const task = await screen.findByRole('button', { name: /阅读/ });
    await waitFor(() => expect(task).toBeEnabled());
    fireEvent.click(task);
    expect(within(screen.getByRole('dialog')).getByText(`${content.date}：2026-10-29`)).toBeInTheDocument();
  });
});

describe('任务配置与管理记录', () => {
  it('新增任务明确提交星期、次数、奖励及类别', async () => {
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => options?.method === 'POST' ? taskFixture : path === '/assets' ? { items: [{ key: 'book-v1', name: '阅读', kind: 'icon', url: '/api/v1/assets/book-v1' }] } : { items: [] });
    render(<CheckinManagement client={{ request }} session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: content.newTask }));
    await screen.findByRole('option', { name: '阅读' });
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '阅读' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: content.save }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/management/tasks', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ name: '阅读', daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true }) })));
  });
});


describe('提交恢复与读取竞争边界', () => {
  it('关闭未知提交后再次打开仍保存原命令，修改草稿不换幂等键', async () => {
    const request = vi.fn().mockRejectedValueOnce(new ApiFailure(0, { code: 'NETWORK_ERROR', field_errors: {}, request_id: '' })).mockResolvedValueOnce(result);
    const client = { request };
    const close = vi.fn();
    const first = render(<CheckinComposer client={client} session={session} task={taskFixture} date={session.today} onClose={close} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.text), { target: { value: '原始文字' } });
    fireEvent.click(screen.getByRole('button', { name: content.checkin }));
    await screen.findByText(content.unknownResult);
    fireEvent.click(screen.getByRole('button', { name: content.close }));
    expect(close).toHaveBeenCalled();
    first.unmount();
    render(<CheckinComposer client={client} session={session} task={taskFixture} date="2026-10-30" onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(content.text)).toHaveValue('原始文字');
    fireEvent.click(screen.getByRole('button', { name: content.recover }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
    expect(request.mock.calls[1]?.[1].body.expected_today).toBe('2026-10-29');
  });

  it('跨日失败保留草稿，只有明确重新确认后才采用新日期和配置', async () => {
    const request = vi.fn().mockRejectedValueOnce(new ApiFailure(409, { code: 'DAY_CHANGED', field_errors: {}, request_id: '' })).mockResolvedValueOnce({ items: [{ ...taskFixture, version: 2 }] }).mockResolvedValueOnce({ ...session, today: '2026-10-30' }).mockResolvedValueOnce(result);
    render(<CheckinComposer client={{ request }} session={session} task={taskFixture} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.text), { target: { value: '没有丢失的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: content.checkin }));
    await screen.findByText(content.errors.DAY_CHANGED);
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(content.text)).toHaveValue('没有丢失的草稿');
    fireEvent.click(screen.getByRole('button', { name: content.confirmLatest }));
    await screen.findByText(`${content.date}：2026-10-30`);
    fireEvent.click(screen.getByRole('button', { name: content.checkin }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    expect(request.mock.calls[3]?.[1].body).toMatchObject({ expected_today: '2026-10-30', expected_task_version: 2, text: '没有丢失的草稿' });
    expect(request.mock.calls[3]?.[1].idempotencyKey).not.toBe(request.mock.calls[0]?.[1].idempotencyKey);
  });

  it('晚到的旧日期响应不能覆盖新日期记录', async () => {
    let finishOld: (value: unknown) => void = () => {};
    const oldPage = new Promise((resolve) => { finishOld = resolve; });
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return campFixture;
      if (path.includes('2026-10-29')) return oldPage;
      return { items: [], next_cursor: null };
    });
    render(<CampPage client={{ request }} session={session} />);
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining('start_date=2026-10-29')));
    fireEvent.click(screen.getByRole('button', { name: content.previousDay }));
    await screen.findByText(content.noRecords);
    await act(async () => { finishOld({ items: [{ ...recordFixture, task_name_snapshot: '迟到的旧记录' }], next_cursor: null }); await oldPage; });
    expect(screen.queryByText('迟到的旧记录')).not.toBeInTheDocument();
    expect(screen.getByText('2026-10-28')).toBeInTheDocument();
  });

  it('关闭未提交的文字先确认放弃，不发起任何写请求', () => {
    const request = vi.fn();
    const close = vi.fn();
    render(<CheckinComposer client={{ request }} session={session} task={taskFixture} date={session.today} onClose={close} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.text), { target: { value: '草稿' } });
    fireEvent.click(screen.getByRole('button', { name: content.close }));
    expect(screen.getByText(content.discardQuestion)).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: content.discard }));
    expect(close).toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('审查发现的恢复路径', () => {
  it('超长新草稿不会阻止合法原提交核对，成功后仍禁止保存超长编辑', async () => {
    const request = vi.fn().mockRejectedValueOnce(new ApiFailure(0, { code: 'NETWORK_ERROR', field_errors: {}, request_id: '' })).mockResolvedValueOnce(result);
    render(<CheckinComposer client={{ request }} session={session} task={taskFixture} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.text), { target: { value: '原始文字' } });
    fireEvent.click(screen.getByRole('button', { name: content.checkin }));
    await screen.findByText(content.unknownResult);
    fireEvent.change(screen.getByLabelText(content.text), { target: { value: '长'.repeat(session.limits.text_max + 1) } });
    expect(screen.getByRole('button', { name: content.recover })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: content.recover }));
    await screen.findByText(content.resolvedEdit);
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
  });

  it('记录删除版本冲突后显式加载最新记录，用户再次确认才删除新版本', async () => {
    const latest = { ...recordFixture, version: 2, text: '别人刚更新的内容' };
    const request = vi.fn().mockRejectedValueOnce(new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' })).mockResolvedValueOnce({ items: [], next_cursor: 'next-page' }).mockResolvedValueOnce({ items: [latest], next_cursor: null }).mockResolvedValueOnce({ deleted: true, wallet: result.wallet });
    render(<RecordDialog client={{ request }} session={session} record={recordFixture} today={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: content.delete }));
    fireEvent.click(screen.getByRole('button', { name: content.confirmDelete }));
    await screen.findByText(content.errors.VERSION_CONFLICT);
    fireEvent.click(screen.getByRole('button', { name: content.refreshRecord }));
    await screen.findByText(latest.text);
    expect(request.mock.calls.filter((call) => call[1]?.method === 'DELETE')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: content.delete }));
    fireEvent.click(screen.getByRole('button', { name: content.confirmDelete }));
    await waitFor(() => expect(request.mock.calls.filter((call) => call[1]?.method === 'DELETE')).toHaveLength(2));
    expect(request.mock.calls[3]?.[1]).toMatchObject({ body: { expected_version: 2 } });
    expect(request.mock.calls[2]?.[0]).toContain('cursor=next-page');
  });

  it('配置删除冲突后显示最新名称和版本，不自动重试删除', async () => {
    const latest = { ...taskFixture, name: '更新后的项目', version: 2 };
    let taskReads = 0;
    let deletes = 0;
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'DELETE') {
        deletes++;
        if (deletes === 1) throw new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' });
        return undefined;
      }
      if (path.startsWith('/tasks')) { taskReads++; return { items: [taskReads === 1 ? taskFixture : latest] }; }
      return { items: [] };
    });
    render(<CheckinManagement client={{ request }} session={session} />);
    await screen.findByText(taskFixture.name);
    fireEvent.click(screen.getByRole('button', { name: content.remove }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: content.remove }));
    await screen.findAllByText(content.errors.VERSION_CONFLICT);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: content.confirmLatest }));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('heading', { name: latest.name })).toBeInTheDocument());
    expect(deletes).toBe(1);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: content.remove }));
    await waitFor(() => expect(deletes).toBe(2));
    expect(request.mock.calls.filter((call) => call[1]?.method === 'DELETE')[1]?.[1]).toMatchObject({ body: { expected_version: 2 } });
  });
});

it('未知编辑关闭并跨日后，普通只读详情仍提供原结果核对入口', async () => {
  const { rememberEdit } = await import('./media-submission');
  const { emptyMediaDraft } = await import('../media/media-draft');
  const request = vi.fn();
  const client = { request };
  rememberEdit(client, recordFixture.id, { path: `/checkins/${recordFixture.id}`, record: recordFixture, body: { expected_version: recordFixture.version, text: '未知修改', photo_media_id: null, audio_media_id: null }, draftText: '未知修改', draftMedia: emptyMediaDraft() });
  render(<RecordDialog client={client} session={session} record={{ ...recordFixture, can_edit: false, can_delete: false }} today="2026-10-30" onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.queryByRole('button', { name: content.edit })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: content.recover }));
  expect(screen.getByLabelText(content.text)).toHaveValue('未知修改');
  expect(screen.getByRole('button', { name: content.recover })).toBeEnabled();
});
