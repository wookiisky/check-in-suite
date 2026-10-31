import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AchievementPanel } from './AchievementPage';
import { AchievementStrip } from './AchievementStrip';
import { achievementFixture } from './test-fixtures';
import type { Achievement } from './types';
import content from './content.json';

describe('背包中的徽章管理', () => {
  it('嵌入时没有页面标题，读取与佩戴成功都同步完整列表和提交状态', async () => {
    const pending = { ...achievementFixture, id: 'pending', name: '未来徽章', qualified: false, equipped: false };
    let finish!: (item: Achievement) => void;
    const saved = { ...achievementFixture, equipped: true };
    const request = vi.fn().mockImplementation((path: string) => path.includes('/equipment')
      ? new Promise<Achievement>((resolve) => { finish = resolve; })
      : Promise.resolve({ items: [achievementFixture, pending] }));
    const changed = vi.fn();
    const busy = vi.fn();
    render(<AchievementPanel client={{ request }} onItemsChange={changed} onBusyChange={busy} />);
    await screen.findByRole('button', { name: content.equip });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(changed).toHaveBeenLastCalledWith([achievementFixture, pending]);
    fireEvent.click(screen.getByRole('button', { name: content.equip }));
    expect(busy).toHaveBeenLastCalledWith(true);
    expect(changed).toHaveBeenCalledTimes(1);
    await act(async () => finish(saved));
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith([saved, pending]));
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: content.unequip })).toBeEnabled();
  });

  it('提交失败不修改预览，仍可重试佩戴', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path.includes('/equipment')) throw new TypeError('offline');
      return { items: [achievementFixture] };
    });
    const changed = vi.fn();
    const busy = vi.fn();
    render(<AchievementPanel client={{ request }} onItemsChange={changed} onBusyChange={busy} />);
    fireEvent.click(await screen.findByRole('button', { name: content.equip }));
    await screen.findByRole('alert');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith([achievementFixture]);
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: content.equip })).toBeEnabled();
  });

  it('离开后迟到的提交不能更新已卸载界面的预览', async () => {
    let finish!: (item: Achievement) => void;
    const request = vi.fn().mockImplementation((path: string) => path.includes('/equipment')
      ? new Promise<Achievement>((resolve) => { finish = resolve; })
      : Promise.resolve({ items: [achievementFixture] }));
    const changed = vi.fn();
    const busy = vi.fn();
    const view = render(<AchievementPanel client={{ request }} onItemsChange={changed} onBusyChange={busy} />);
    fireEvent.click(await screen.findByRole('button', { name: content.equip }));
    view.unmount();
    expect(busy).toHaveBeenLastCalledWith(false);
    await act(async () => finish({ ...achievementFixture, equipped: true }));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('首页徽章展示不再要求第二个管理入口，详情仍可打开', () => {
    render(<AchievementStrip items={[{ ...achievementFixture, equipped: true }]} />);
    expect(screen.queryByRole('button', { name: content.viewAll })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `${content.details} ${achievementFixture.name}` }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
