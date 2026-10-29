import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../api/client';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { ConfigDialog } from './ConfigDialog';
import { taskFixture } from './test-fixtures';
import type { Category, Task } from './types';
import content from './content.json';

const session = testSession as Session;
const category: Category = { id: 'category-1', name: '学习', sort_order: 1, version: 1 };
const nextCategory: Category = { id: 'category-2', name: '新的类别', sort_order: 2, version: 1 };
const latestTask: Task = { ...taskFixture, version: 2, name: '另一设备的名称', category_id: nextCategory.id, icon_key: 'star-v1', coin_reward: 99, diamond_reward: 7, daily_limit: 8, weekdays: [2, 4], enabled: false, unlock_activities: ['run'] };
const conflict = () => new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' });
const assets = { items: [{ key: 'book-v1', name: '书本图标', kind: 'icon' }, { key: 'star-v1', name: '星星图标', kind: 'icon' }] };

describe('配置编辑冲突恢复', () => {
  it('任务冲突后展示完整最新配置，只有明确覆盖才发送新版本与保留草稿', async () => {
    const patch = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce(latestTask);
    const request = vi.fn(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'PATCH') return patch(path, options);
      if (path === '/assets') return assets;
      if (path === '/categories') return { items: [category, nextCategory] };
      return { items: [latestTask] };
    });
    const saved = vi.fn();
    render(<ConfigDialog client={{ request }} session={session} kind="task" item={taskFixture} categories={[category]} onClose={vi.fn()} onSaved={saved} />);
    await screen.findByRole('option', { name: '书本图标' });
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '我的名称' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByText(content.errors.VERSION_CONFLICT);
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText(content.name).closest('form')!);
    expect(patch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: content.confirmLatest }));
    const current = await screen.findByRole('region', { name: '服务端最新配置' });
    for (const value of [latestTask.name, nextCategory.name, '星星图标', '99', '7', '8', '星期二、星期四', content.disabled, '运动活动']) {
      expect(within(current).getByText(value)).toBeInTheDocument();
    }
    expect(screen.getByLabelText(content.name)).toHaveValue('我的名称');
    expect(screen.getByLabelText(content.coins)).toHaveValue(2);
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(content.coins), { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: '以当前草稿覆盖并保存' }));
    expect(patch).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText(content.coins), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '以当前草稿覆盖并保存' }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(patch.mock.calls[1]?.[1]).toMatchObject({ body: { expected_version: 2, name: '我的名称', coin_reward: 2, icon_key: 'book-v1', enabled: true, unlock_activities: [] } });
  });

  it('采用最新任务同步全部表单字段，再次保存不会恢复旧奖励或类别', async () => {
    const patch = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce(latestTask);
    const request = vi.fn(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'PATCH') return patch(path, options);
      if (path === '/assets') return assets;
      if (path === '/categories') return { items: [nextCategory] };
      return { items: [latestTask] };
    });
    render(<ConfigDialog client={{ request }} session={session} kind="task" item={{ ...taskFixture, category_id: category.id }} categories={[category]} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByRole('option', { name: '书本图标' });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    fireEvent.click(await screen.findByRole('button', { name: content.confirmLatest }));
    await screen.findByRole('button', { name: '使用最新配置' });
    expect(screen.getByLabelText(content.category)).toHaveValue(category.id);
    expect(screen.getByRole('option', { name: content.unavailableCategory })).toHaveValue(category.id);
    fireEvent.click(screen.getByRole('button', { name: '使用最新配置' }));
    expect(screen.getByLabelText(content.name)).toHaveValue(latestTask.name);
    expect(screen.getByLabelText(content.category)).toHaveValue(nextCategory.id);
    expect(screen.getByLabelText(content.icon)).toHaveValue(latestTask.icon_key);
    expect(screen.getByLabelText(content.coins)).toHaveValue(99);
    expect(screen.getByLabelText(content.diamonds)).toHaveValue(7);
    expect(screen.getByLabelText(content.dailyLimit)).toHaveValue(8);
    expect(screen.getByLabelText(content.enabled)).not.toBeChecked();
    expect(screen.getByLabelText('运动活动')).toBeChecked();
    expect(screen.getByLabelText('阅读活动')).not.toBeChecked();
    expect(screen.getByLabelText(content.weekdays[0]!)).not.toBeChecked();
    expect(screen.getByLabelText(content.weekdays[1]!)).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[1]?.[1]).toMatchObject({ body: { expected_version: 2, category_id: nextCategory.id, coin_reward: 99, weekdays: [2, 4], enabled: false, unlock_activities: ['run'] } });
  });

  it('类别冲突时保留草稿与最新排序，读取失败可重试，再次冲突必须重新核对', async () => {
    const latest = { ...category, name: '远端类别', sort_order: 15, version: 2 };
    const reload = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [latest] });
    const patch = vi.fn().mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());
    const request = vi.fn(async (path: string, options?: { method?: string }) => options?.method === 'PATCH' ? patch(path, options) : reload());
    render(<ConfigDialog client={{ request }} session={session} kind="category" item={category} categories={[category]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '本地类别' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    fireEvent.click(await screen.findByRole('button', { name: content.confirmLatest }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: content.confirmLatest })).toBeEnabled());
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '以当前草稿覆盖并保存' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.confirmLatest }));
    const current = await screen.findByRole('region', { name: '服务端最新配置' });
    expect(within(current).getByText('15')).toBeInTheDocument();
    expect(screen.getByLabelText(content.name)).toHaveValue('本地类别');
    fireEvent.click(screen.getByRole('button', { name: '以当前草稿覆盖并保存' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    await screen.findByText(content.errors.VERSION_CONFLICT);
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '以当前草稿覆盖并保存' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.confirmLatest }));
    fireEvent.click(await screen.findByRole('button', { name: '使用最新配置' }));
    expect(screen.getByLabelText(content.name)).toHaveValue('远端类别');
    expect(screen.getByLabelText(content.sortOrder)).toHaveValue(15);
  });
});
