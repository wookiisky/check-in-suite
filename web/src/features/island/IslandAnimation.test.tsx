import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { testSession } from '../../test/account-fixtures';
import { camp } from '../shop/test-fixtures';
import { IslandPage } from './IslandPage';
import { state } from './island-test-fixtures';
import { IslandAnimationTestClock } from './island-animation-test-clock';
import content from './content.json';

const session = { ...testSession, timezone: 'Asia/Taipei' as const };

// 从真实SVG位置观察移动，不以内部回调次数代替页面效果。
function actorX() {
  const transform = document.querySelector('[data-actor-zone]')!.getAttribute('transform')!;
  return Number(transform.match(/translate\(([^ ]+) /)![1]);
}

// 手动选择一段室外行走，避免随机活动影响时钟断言。
async function renderWalking() {
  const client = { request: vi.fn().mockImplementation(async (path) => path === '/camp' ? camp : state) };
  const view = render(<IslandPage client={client} session={session} />);
  const activities = await screen.findByRole('region', { name: content.activitiesTitle });
  fireEvent.click(within(activities).getByRole('button', { name: `${content.activities.run} 运动区` }));
  return { ...view, client };
}

describe('小岛动画时钟', () => {
  it('按实际帧间隔连续移动，重新渲染后仍只有一个帧循环', async () => {
    const clock = new IslandAnimationTestClock();
    await renderWalking();
    const start = actorX();
    expect(clock.callbacks.size).toBe(1);
    clock.frame(1000);
    expect(actorX()).toBe(start);
    clock.frame(1010);
    expect(actorX() - start).toBeCloseTo(2.2 * 0.01 * 24);
    clock.frame(1030);
    expect(actorX() - start).toBeCloseTo(2.2 * 0.03 * 24);
    expect(clock.callbacks.size).toBe(1);
  });

  it.each(['pause', 'edit', 'reduce'] as const)('%s暂停时停止调度，恢复首帧不补算时间', async (mode) => {
    const clock = new IslandAnimationTestClock();
    const view = await renderWalking();
    clock.frame(1000);
    clock.frame(1016);
    const before = actorX();
    if (mode === 'pause') fireEvent.click(screen.getByRole('button', { name: content.pause }));
    if (mode === 'edit') fireEvent.click(screen.getByRole('button', { name: content.edit }));
    if (mode === 'reduce') view.rerender(<IslandPage client={view.client} session={{ ...session, account: { ...session.account, preferences: { ...session.account.preferences, reduce_motion: true } } }} />);
    expect(clock.callbacks.size).toBe(0);
    clock.frame(60000);
    expect(actorX()).toBe(before);
    if (mode === 'pause') fireEvent.click(screen.getByRole('button', { name: content.resume }));
    if (mode === 'edit') fireEvent.click(screen.getByRole('button', { name: content.cancel }));
    if (mode === 'reduce') view.rerender(<IslandPage client={view.client} session={session} />);
    expect(clock.callbacks.size).toBe(1);
    clock.frame(61000);
    expect(actorX()).toBe(before);
    clock.frame(61016);
    expect(actorX() - before).toBeCloseTo(2.2 * 0.016 * 24);
  });

  it('隐藏时取消帧，恢复首帧重新计时，多次可见事件不重复调度', async () => {
    const clock = new IslandAnimationTestClock();
    await renderWalking();
    clock.frame(1000);
    clock.frame(1016);
    const before = actorX();
    clock.setVisibility('hidden');
    expect(clock.callbacks.size).toBe(0);
    clock.frame(60000);
    expect(actorX()).toBe(before);
    clock.setVisibility('visible');
    clock.setVisibility('visible');
    expect(clock.callbacks.size).toBe(1);
    clock.frame(61000);
    expect(actorX()).toBe(before);
    clock.frame(61016);
    expect(actorX() - before).toBeCloseTo(2.2 * 0.016 * 24);
  });

  it('长帧限制单次位移，卸载后释放帧和可见性监听', async () => {
    const clock = new IslandAnimationTestClock();
    const view = await renderWalking();
    clock.frame(1000);
    const before = actorX();
    clock.frame(11000);
    expect(actorX() - before).toBeGreaterThan(0);
    expect(actorX() - before).toBeLessThanOrEqual(2.2 * 0.05 * 24 + 1e-8);
    view.unmount();
    expect(clock.callbacks.size).toBe(0);
    clock.setVisibility('hidden');
    clock.setVisibility('visible');
    expect(clock.callbacks.size).toBe(0);
  });
});
