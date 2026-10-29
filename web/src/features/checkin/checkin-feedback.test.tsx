import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/types';
import { ApiFailure } from '../../api/client';
import { testSession } from '../../test/account-fixtures';
import { CampPage } from './CampPage';
import { CHECKIN_SUCCESS_EVENT } from './events';
import { campFixture, recordFixture } from './test-fixtures';
import content from './content.json';

const session = testSession as Session;

describe('打卡奖励反馈', () => {
  it('展示回执中的实际奖励，重复记录响应和普通刷新不重复庆祝', async () => {
    const confirmed = { ...recordFixture, coin_reward_snapshot: 7, diamond_reward_snapshot: 3 };
    let created = false;
    let walletVersion = 2;
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') {
        created = true;
        return { checkin: confirmed, wallet: { coins: 500, diamonds: 90, version: 2 }, task_remaining: 1, today: testSession.today };
      }
      if (path === '/camp') return { ...campFixture, wallet: { coins: created ? 500 : 0, diamonds: created ? 90 : 0, version: created ? walletVersion : 1 } };
      return { items: created ? [confirmed] : [], next_cursor: null };
    });
    const success = vi.fn();
    window.addEventListener(CHECKIN_SUCCESS_EVENT, success);
    const view = render(<CampPage client={{ request }} session={session} />);
    try {
      const task = await screen.findByRole('button', { name: /阅读.*金币/ });
      await waitFor(() => expect(task).toBeEnabled());
      expect(screen.queryByText(`${content.coins} +7`)).not.toBeInTheDocument();
      fireEvent.click(task);
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: content.checkin }));
      expect(await screen.findByText(`${content.coins} +7`)).toBeVisible();
      expect(screen.getByText(`${content.diamonds} +3`)).toBeVisible();
      expect(view.container.querySelectorAll('.checkin-reward-coins .checkin-reward-particle')).toHaveLength(7);
      expect(view.container.querySelectorAll('.checkin-reward-diamonds .checkin-reward-particle')).toHaveLength(3);
      await waitFor(() => expect(within(screen.getByLabelText(content.balance)).getByText('500')).toHaveClass('feedback-pop'));
      expect(success).toHaveBeenCalledTimes(1);
      expect(success.mock.calls[0]![0].detail).toEqual({ recordId: confirmed.id, coins: 7, diamonds: 3 });
      const balanceBeforeRefresh = within(screen.getByLabelText(content.balance)).getByText('500');
      fireEvent.animationEnd(balanceBeforeRefresh);
      walletVersion = 3;
      fireEvent.click(screen.getByRole('button', { name: content.previousDay }));
      await waitFor(() => expect(task).toBeEnabled());
      expect(within(screen.getByLabelText(content.balance)).getByText('500')).toBe(balanceBeforeRefresh);
      await waitFor(() => expect(task).toBeEnabled());
      fireEvent.click(task);
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: content.checkin }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(success).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(`${content.coins} +7`)).not.toBeInTheDocument();
      expect(view.container.querySelectorAll('.checkin-reward-particle')).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: content.previousDay }));
      await screen.findByText(content.historyReadOnly);
      expect(success).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); window.removeEventListener(CHECKIN_SUCCESS_EVENT, success); }
  });

  it('失败不展示奖励，减少动效时成功仍展示静态奖励', async () => {
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') throw new ApiFailure(409, { code: 'TASK_CHANGED', field_errors: {}, request_id: '' });
      return path === '/camp' ? campFixture : { items: [], next_cursor: null };
    });
    const view = render(<CampPage client={{ request }} session={session} />);
    const task = await screen.findByRole('button', { name: /阅读.*金币/ });
    await waitFor(() => expect(task).toBeEnabled());
    fireEvent.click(task);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: content.checkin }));
    await screen.findByText(content.errors.TASK_CHANGED);
    expect(screen.queryByText(`${content.coins} +2`)).not.toBeInTheDocument();
    view.unmount();
    const reducedSession = { ...session, account: { ...testSession.account, preferences: { ...testSession.account.preferences, reduce_motion: true } } };
    request.mockImplementation(async (path: string, options?: { method?: string }) => options?.method === 'POST'
      ? { checkin: recordFixture, wallet: campFixture.wallet, task_remaining: 1, today: testSession.today }
      : path === '/camp' ? campFixture : { items: [], next_cursor: null });
    render(<CampPage client={{ request }} session={reducedSession} />);
    const nextTask = await screen.findByRole('button', { name: /阅读.*金币/ });
    await waitFor(() => expect(nextTask).toBeEnabled());
    fireEvent.click(nextTask);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: content.checkin }));
    expect(await screen.findByText(`${content.coins} +2`)).toBeVisible();
    expect(screen.getByText(content.success).closest('[role=status]')).not.toHaveClass('checkin-celebrate');
  });
});
