import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckinRewardFeedback } from './CheckinRewardFeedback';
import content from './content.json';

afterEach(() => vi.useRealTimers());

describe('奖励数量动效', () => {
  it.each([1, 2, 20, 49, 50, 51, 1000000])('奖励 %i 按单位生成图标，每种最多 50 个', (amount) => {
    const { container } = render(<CheckinRewardFeedback coins={amount} diamonds={amount} reduceMotion={false} />);
    expect(container.querySelectorAll('.checkin-reward-coins .checkin-reward-particle')).toHaveLength(Math.min(amount, 50));
    expect(container.querySelectorAll('.checkin-reward-diamonds .checkin-reward-particle')).toHaveLength(Math.min(amount, 50));
    expect(within(screen.getByRole('img', { name: content.coins }).parentElement!).getByText(`+${amount}`)).toBeVisible();
    expect(within(screen.getByRole('img', { name: content.diamonds }).parentElement!).getByText(`+${amount}`)).toBeVisible();
  });

  it('两种奖励分别计数，钻石有独立高亮展示且装饰不重复朗读', () => {
    const { container } = render(<CheckinRewardFeedback coins={7} diamonds={3} reduceMotion={false} />);
    expect(container.querySelectorAll('.checkin-reward-coins .checkin-reward-particle')).toHaveLength(7);
    expect(container.querySelectorAll('.checkin-reward-diamonds .checkin-reward-particle')).toHaveLength(3);
    expect(container.querySelector('.checkin-reward-diamonds')).toHaveClass('checkin-reward-featured');
    expect(container).not.toHaveTextContent(/金币|钻石/);
    expect(screen.getByRole('img', { name: content.coins })).toBeVisible();
    expect(screen.getByRole('img', { name: content.diamonds })).toBeVisible();
    for (const layer of container.querySelectorAll('.checkin-reward-particles')) expect(layer).toHaveAttribute('aria-hidden', 'true');
  });

  it.each([[0, 0], [4, 0], [0, 4]])('零奖励不生成粒子或钻石高亮：金币 %i、钻石 %i', (coins, diamonds) => {
    const { container } = render(<CheckinRewardFeedback coins={coins} diamonds={diamonds} reduceMotion={false} />);
    expect(container.querySelectorAll('.checkin-reward-coins .checkin-reward-particle')).toHaveLength(coins);
    expect(container.querySelectorAll('.checkin-reward-diamonds .checkin-reward-particle')).toHaveLength(diamonds);
    expect(container.querySelector('.checkin-reward-diamonds')?.classList.contains('checkin-reward-featured')).toBe(diamonds > 0);
  });

  it('减少动效时只保留准确金额与静态钻石展示，关闭偏好不补播旧奖励', () => {
    const { container, rerender } = render(<CheckinRewardFeedback coins={50} diamonds={3} reduceMotion />);
    expect(container.querySelectorAll('.checkin-reward-particle')).toHaveLength(0);
    expect(screen.getByText('+3')).toBeVisible();
    expect(container.querySelector('.checkin-reward-diamonds')).toHaveClass('checkin-reward-featured');
    rerender(<CheckinRewardFeedback coins={50} diamonds={3} reduceMotion={false} />);
    expect(container.querySelectorAll('.checkin-reward-particle')).toHaveLength(0);
  });

  it('播放结束释放粒子，普通刷新不重播，新记录重新播放', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<CheckinRewardFeedback key="first" coins={2} diamonds={1} reduceMotion={false} />);
    expect(container.querySelectorAll('.checkin-reward-particle')).toHaveLength(3);
    act(() => vi.advanceTimersByTime(2000));
    expect(container.querySelectorAll('.checkin-reward-particle')).toHaveLength(0);
    expect(screen.getByText('+2')).toBeVisible();
    rerender(<CheckinRewardFeedback key="first" coins={2} diamonds={1} reduceMotion={false} />);
    expect(container.querySelectorAll('.checkin-reward-particle')).toHaveLength(0);
    rerender(<CheckinRewardFeedback key="second" coins={2} diamonds={1} reduceMotion={false} />);
    expect(container.querySelectorAll('.checkin-reward-particle')).toHaveLength(3);
  });

  it('播放中开启减少动效立即移除粒子，再关闭也不重播', () => {
    const { container, rerender } = render(<CheckinRewardFeedback coins={2} diamonds={1} reduceMotion={false} />);
    rerender(<CheckinRewardFeedback coins={2} diamonds={1} reduceMotion />);
    expect(container.querySelectorAll('.checkin-reward-particle')).toHaveLength(0);
    rerender(<CheckinRewardFeedback coins={2} diamonds={1} reduceMotion={false} />);
    expect(container.querySelectorAll('.checkin-reward-particle')).toHaveLength(0);
  });
});
