import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../api/client';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { CheckinManagement } from './CheckinManagement';
import { taskFixture } from './test-fixtures';
import content from './content.json';

const session = testSession as Session;

describe('任务开启和关闭', () => {
  it('默认隐藏关闭任务，显示后可以重新开启并使用服务端返回的版本', async () => {
    const closed = { ...taskFixture, enabled: false };
    const patch = vi.fn().mockResolvedValueOnce({ ...closed, enabled: true, version: 2 }).mockResolvedValueOnce({ ...closed, version: 3 });
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'PATCH') return patch(path, options);
      return { items: path.startsWith('/tasks') ? [closed] : [] };
    });
    render(<CheckinManagement client={{ request }} session={session} />);
    await screen.findByText(content.noActiveTasks);
    expect(screen.queryByText(closed.name)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(content.showDisabledTasks));
    fireEvent.click(await screen.findByRole('button', { name: `${content.enableTask} ${closed.name}` }));
    await screen.findByText(content.taskEnabled);
    fireEvent.click(screen.getByLabelText(content.showDisabledTasks));
    fireEvent.click(screen.getByRole('button', { name: `${content.disableTask} ${closed.name}` }));
    await screen.findByText(content.taskDisabled);
    expect(patch.mock.calls[1]?.[1]).toMatchObject({ body: { enabled: false, expected_version: 2 } });
    expect(screen.queryByText(closed.name)).not.toBeInTheDocument();
  });

  it('关闭只提交配置字段，成功后隐藏并将焦点移到找回入口', async () => {
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'PATCH') return { ...taskFixture, enabled: false, version: 2 };
      return { items: path.startsWith('/tasks') ? [taskFixture] : [] };
    });
    render(<CheckinManagement client={{ request }} session={session} />);
    const button = await screen.findByRole('button', { name: `${content.disableTask} ${taskFixture.name}` });
    button.focus();
    fireEvent.click(button);
    await screen.findByText(content.taskDisabled);
    expect(request).toHaveBeenCalledWith(`/management/tasks/${taskFixture.id}`, {
      method: 'PATCH', body: {
        name: taskFixture.name, category_id: taskFixture.category_id, icon_key: taskFixture.icon_key,
        coin_reward: taskFixture.coin_reward, diamond_reward: taskFixture.diamond_reward,
        daily_limit: taskFixture.daily_limit, weekdays: taskFixture.weekdays, enabled: false, expected_version: 1,
      },
    });
    expect(screen.queryByText(taskFixture.name)).not.toBeInTheDocument();
    expect(screen.getByLabelText(content.showDisabledTasks)).toHaveFocus();
  });

  it('保存期间保留任务并禁止重复提交、编辑和删除', async () => {
    let finish = () => {};
    const saving = new Promise((resolve) => { finish = () => resolve({ ...taskFixture, enabled: false, version: 2 }); });
    const patch = vi.fn(() => saving);
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'PATCH') return patch();
      return { items: path.startsWith('/tasks') ? [taskFixture] : [] };
    });
    render(<CheckinManagement client={{ request }} session={session} />);
    const button = await screen.findByRole('button', { name: `${content.disableTask} ${taskFixture.name}` });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(screen.getByText(taskFixture.name)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: content.editConfig })).toBeDisabled();
    expect(screen.getByRole('button', { name: content.remove })).toBeDisabled();
    expect(screen.getByRole('button', { name: content.newTask })).toBeDisabled();
    await act(async () => { finish(); await saving; });
    expect(screen.queryByText(taskFixture.name)).not.toBeInTheDocument();
  });

  it.each(['VERSION_CONFLICT', 'NETWORK_ERROR', 'INVALID_REQUEST'])('%s 后保持原状态，重读失败仍禁止写入，重读成功不自动重发', async (code) => {
    let reads = 0;
    const latest = { ...taskFixture, name: '最新任务', coin_reward: 8, version: 3 };
    const patch = vi.fn().mockRejectedValueOnce(new ApiFailure(code === 'NETWORK_ERROR' ? 0 : 409, { code, field_errors: {}, request_id: '' }))
      .mockResolvedValueOnce({ ...latest, enabled: false, version: 4 });
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'PATCH') return patch(path, options);
      if (!path.startsWith('/tasks')) return { items: [] };
      reads++;
      if (reads === 2) throw new Error('read failed');
      return { items: [reads === 1 ? taskFixture : latest] };
    });
    render(<CheckinManagement client={{ request }} session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: `${content.disableTask} ${taskFixture.name}` }));
    await screen.findByRole('alert');
    expect(screen.getByText(taskFixture.name)).toBeInTheDocument();
    expect(screen.queryByText(content.taskDisabled)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${content.disableTask} ${taskFixture.name}` })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.reload }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: `${content.disableTask} ${taskFixture.name}` })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.reload }));
    const button = await screen.findByRole('button', { name: `${content.disableTask} ${latest.name}` });
    expect(patch).toHaveBeenCalledTimes(1);
    fireEvent.click(button);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[1]?.[1]).toMatchObject({ body: { name: latest.name, coin_reward: 8, expected_version: 3, enabled: false } });
  });

  it('没有任何任务时显示新增提示，不显示全部关闭的提示', async () => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    render(<CheckinManagement client={{ request }} session={session} />);
    await screen.findByText(content.emptyTasks);
    expect(screen.queryByText(content.noActiveTasks)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: content.newTask })).toBeEnabled();
  });
});
