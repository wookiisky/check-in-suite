import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfigDialog } from './ConfigDialog';
import { taskFixture } from './test-fixtures';
import { testSession } from '../../test/account-fixtures';
import type { Session } from '../../api/types';
import content from './content.json';

const assets = { items: [{ key: 'book-v1', name: '书本图标', kind: 'icon' }] };

describe('任务关联小岛活动', () => {
  it('编辑任务可同时选择多个活动，也可清空全部关联', async () => {
    const patch = vi.fn().mockResolvedValue(taskFixture);
    const request = vi.fn(async (_path: string, options?: { method?: string }) => options?.method === 'PATCH' ? patch(options) : assets);
    const saved = vi.fn();
    render(<ConfigDialog client={{ request }} session={testSession as Session} kind="task" item={taskFixture} categories={[]} onClose={vi.fn()} onSaved={saved} />);
    await screen.findByRole('option', { name: '书本图标' });
    fireEvent.click(screen.getByLabelText('阅读活动'));
    fireEvent.click(screen.getByLabelText('玩球活动'));
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(patch.mock.calls[0]?.[0]).toMatchObject({ body: { unlock_activities: ['read', 'ball'] } });
    fireEvent.click(screen.getByLabelText('阅读活动'));
    fireEvent.click(screen.getByLabelText('玩球活动'));
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[1]?.[0]).toMatchObject({ body: { unlock_activities: [] } });
  });

  it('新增结果不明时禁止改关联，并携带相同关联和幂等键核对原提交', async () => {
    const post = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(taskFixture);
    const request = vi.fn(async (_path: string, options?: { method?: string }) => options?.method === 'POST' ? post(options) : assets);
    render(<ConfigDialog client={{ request }} session={testSession as Session} kind="task" item={null} categories={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByRole('option', { name: '书本图标' });
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '晨间任务' } });
    fireEvent.click(screen.getByLabelText('运动活动'));
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByText(content.configUnknown);
    expect(screen.getByLabelText('运动活动')).toBeDisabled();
    expect(screen.getByLabelText('阅读活动')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.retryConfig }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]?.[0]).toEqual(post.mock.calls[0]?.[0]);
    expect(post.mock.calls[1]?.[0]).toMatchObject({ body: { unlock_activities: ['run'] } });
  });
});
