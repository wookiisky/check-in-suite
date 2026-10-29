import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AchievementPage } from './AchievementPage';
import { AchievementStrip } from './AchievementStrip';
import { AchievementEditor } from './AchievementEditor';
import { AchievementManagement } from './AchievementManagement';
import { AchievementDetails } from './AchievementDetails';
import { achievementFixture, achievementOptions, badgeAssets } from './test-fixtures';
import { testSession } from '../../test/account-fixtures';
import type { Session } from '../../api/types';
import { ApiFailure } from '../../api/client';
import content from './content.json';

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

describe('成就浏览和佩戴', () => {
  it('详情显示具体类别名称及已删除状态', () => {
    const item = { ...achievementFixture, scope: 'category' as const, category_id: 'reading', category: { id: 'reading', name: '历史阅读 $& 类别', deleted: true }, tasks: [] };
    render(<AchievementDetails item={item} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveTextContent(item.category.name);
    expect(screen.getByRole('dialog')).toHaveTextContent(content.deleted);
  });

  it('营地详情展示全部指定任务，包括已删除的历史任务', () => {
    const tasks = achievementOptions.tasks.slice(0, 2);
    const item = { ...achievementFixture, scope: 'tasks' as const, task_ids: tasks.map((task) => task.id), category: null, tasks, equipped: true };
    render(<AchievementStrip items={[item]} onViewAll={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: `${content.details} ${item.name}` }));
    const targets = within(screen.getByRole('dialog')).getAllByRole('listitem');
    expect(targets).toHaveLength(2);
    expect(targets[0]).toHaveTextContent(tasks[0]!.name);
    expect(targets[1]).toHaveTextContent(tasks[1]!.name);
    expect(targets[1]).toHaveTextContent(content.deleted);
  });

  it('未获得成就只能查看进度，已获得可佩戴且以服务端结果更新', async () => {
    const locked = { ...achievementFixture, id: 'locked', name: '未来徽章', qualified: false, earned_at: null, progress: 2 };
    const request = vi.fn().mockImplementation(async (path: string) => path.includes('/equipment') ? { ...achievementFixture, equipped: true } : { items: [achievementFixture, locked] });
    render(<AchievementPage client={{ request }} session={session} />);
    await screen.findByRole('heading', { name: achievementFixture.name });
    const owned = screen.getByRole('heading', { name: achievementFixture.name }).closest('article')!;
    const pending = screen.getByRole('heading', { name: locked.name }).closest('article')!;
    expect(within(pending).queryByRole('button', { name: content.equip })).not.toBeInTheDocument();
    fireEvent.click(within(owned).getByRole('button', { name: content.equip }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/achievements/${achievementFixture.id}/equipment`, { method: 'PUT', body: { equipped: true } }));
    await within(owned).findByRole('button', { name: content.unequip });
  });

  it('首页只放徽章图片，点击后才展示名称和条件', () => {
    render(<AchievementStrip items={[{ ...achievementFixture, equipped: true }]} onViewAll={vi.fn()} />);
    expect(screen.queryByRole('heading', { name: achievementFixture.name })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `${content.details} ${achievementFixture.name}` }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: achievementFixture.name })).toBeInTheDocument();
  });

  it('佩戴失败保留原状态并允许重试', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path.includes('/equipment')) throw new TypeError('offline');
      return { items: [achievementFixture] };
    });
    render(<AchievementPage client={{ request }} session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: content.equip }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: content.equip })).toBeEnabled();
  });
});

describe('成就配置', () => {
  it('新增响应丢失后重用原幂等键与原请求，禁用字段避免变更未决命令', async () => {
    const request = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(achievementFixture);
    const saved = vi.fn();
    render(<AchievementEditor client={{ request }} session={session} item={null} options={achievementOptions} assets={badgeAssets} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '阅读小能手' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByText(content.pendingCreate);
    expect(screen.getByLabelText(content.name)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.retryCreate }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
  });

  it('版本冲突保留草稿，加载最新后必须明确确认才覆盖', async () => {
    const latest = { ...achievementFixture, name: '其他设备的成就', target: 20, version: 2 };
    const request = vi.fn().mockRejectedValueOnce(new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' })).mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'PATCH') return { ...latest, name: '我的草稿' };
      return path.endsWith('/options') ? achievementOptions : { items: [latest] };
    });
    render(<AchievementEditor client={{ request }} session={session} item={achievementFixture} options={achievementOptions} assets={badgeAssets} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '我的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    fireEvent.click(await screen.findByRole('button', { name: content.reloadLatest }));
    await screen.findByText(latest.name);
    expect(screen.getByLabelText(content.name)).toHaveValue('我的草稿');
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.confirmDraft }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(`/management/achievements/${latest.id}`, expect.objectContaining({ body: expect.objectContaining({ name: '我的草稿', expected_version: 2 }) })));
  });

  it.each([
    { scope: 'category' as const, deleted: false }, { scope: 'tasks' as const, deleted: false },
    { scope: 'category' as const, deleted: true }, { scope: 'tasks' as const, deleted: true },
  ])('采用最新配置时同步刷新 $scope 关联（deleted=$deleted）并可继续编辑保存', async ({ scope, deleted }) => {
    const category = { id: 'new-category', name: '新建类别', deleted };
    const task = { id: 'new-task', name: '新建任务', category_id: category.id, deleted };
    const latest = { ...achievementFixture, scope, category_id: scope === 'category' ? category.id : null, task_ids: scope === 'tasks' ? [task.id] : [], version: 2 };
    const targets = { categories: [...achievementOptions.categories, category], tasks: [...achievementOptions.tasks, task] };
    const saved = vi.fn();
    const request = vi.fn().mockRejectedValueOnce(new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' })).mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'PATCH') return latest;
      return path.endsWith('/options') ? targets : { items: [latest] };
    });
    render(<AchievementEditor client={{ request }} session={session} item={achievementFixture} options={achievementOptions} assets={badgeAssets} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    fireEvent.click(await screen.findByRole('button', { name: content.reloadLatest }));
    await screen.findByText(scope === 'category' ? category.name : task.name);
    expect(screen.queryByText(content.unavailableTarget)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.useLatest }));
    if (scope === 'category') {
      expect(screen.getByLabelText(content.category)).toHaveValue(category.id);
      expect(screen.getByRole('option', { name: /新建类别/ })).toBeEnabled();
    } else {
      expect(screen.getByRole('checkbox', { name: /新建任务/ })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: /新建任务/ })).toBeEnabled();
    }
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(request).toHaveBeenLastCalledWith(`/management/achievements/${latest.id}`, expect.objectContaining({ body: expect.objectContaining({ category_id: latest.category_id, task_ids: latest.task_ids, expected_version: 2 }) }));
  });

  it('关联选项刷新失败时保留草稿，重试成功后才允许采用最新配置', async () => {
    let optionsFailed = false;
    const latest = { ...achievementFixture, name: '最新配置', version: 2 };
    const request = vi.fn().mockRejectedValueOnce(new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' })).mockImplementation(async (path: string) => {
      if (!path.endsWith('/options')) return { items: [latest] };
      if (!optionsFailed) { optionsFailed = true; throw new TypeError('offline'); }
      return achievementOptions;
    });
    render(<AchievementEditor client={{ request }} session={session} item={achievementFixture} options={achievementOptions} assets={badgeAssets} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '我的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    fireEvent.click(await screen.findByRole('button', { name: content.reloadLatest }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText(content.name)).toHaveValue('我的草稿');
    expect(screen.queryByRole('button', { name: content.useLatest })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.reloadLatest }));
    await screen.findByRole('button', { name: content.useLatest });
  });

  it('已删除关联任务保留且新建时不能选择', () => {
    const item = { ...achievementFixture, scope: 'tasks' as const, task_ids: ['deleted-task'] };
    render(<AchievementEditor client={{ request: vi.fn() }} session={session} item={item} options={achievementOptions} assets={badgeAssets} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: /旧阅读/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /已删除的运动/ })).toBeDisabled();
  });
});


describe('成就读取与管理边界', () => {
  it('读取失败显示恢复入口，重试成功才展示真实结果', async () => {
    const request = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce({ items: [achievementFixture] });
    render(<AchievementPage client={{ request }} session={session} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: content.reload }));
    await screen.findByRole('heading', { name: achievementFixture.name });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('页面卸载取消列表请求，迟到响应不再更新页面', async () => {
    const request = vi.fn().mockImplementation(() => new Promise(() => {}));
    const view = render(<AchievementPage client={{ request }} session={session} />);
    const signal = request.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it('删除配置使用所见版本，冲突后必须重新加载核对', async () => {
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'DELETE') throw new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' });
      if (path === '/assets') return { items: badgeAssets };
      if (path.endsWith('/options')) return achievementOptions;
      return { items: [achievementFixture] };
    });
    render(<AchievementManagement client={{ request }} session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: `${content.delete} ${achievementFixture.name}` }));
    fireEvent.click(screen.getByRole('button', { name: content.confirmDelete }));
    await screen.findByText(content.deleteConflict);
    expect(screen.getByRole('button', { name: content.confirmDelete })).toBeDisabled();
    expect(request).toHaveBeenCalledWith(`/management/achievements/${achievementFixture.id}`, { method: 'DELETE', body: { expected_version: achievementFixture.version } });
    fireEvent.click(screen.getByRole('button', { name: content.reload }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await screen.findByRole('button', { name: `${content.delete} ${achievementFixture.name}` });
  });
});
