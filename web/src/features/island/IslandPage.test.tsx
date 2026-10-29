import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FEEDBACK_EVENT } from '../../feedback/feedback-events';
import { IslandPage } from './IslandPage';
import { state } from './island-test-fixtures';
import { testSession } from '../../test/account-fixtures';
import { camp } from '../shop/test-fixtures';
import { ApiFailure } from '../../api/client';
import content from './content.json';
import { interactionPoint } from './island-geometry';
import { campFixture } from '../checkin/test-fixtures';

describe('小岛页面', () => {
  it('活动只显示物品图标，保留名称提示，点击后恢复并执行活动', async () => {
    const request = vi.fn().mockImplementation(async (path) => path === '/camp' ? camp : state);
    const session = { ...testSession, timezone: 'Asia/Taipei' as const, account: { ...testSession.account, preferences: { ...testSession.account.preferences, reduce_motion: true } } };
    render(<IslandPage client={{ request }} session={session} />);
    const activities = await screen.findByRole('region', { name: content.activitiesTitle });
    const buttons = within(activities).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.textContent).toBe('');
      expect(button).toHaveAttribute('title', button.getAttribute('aria-label'));
      expect(button.querySelector('svg')).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: content.pause }));
    fireEvent.click(within(activities).getByRole('button', { name: `${content.activities.run} 运动区` }));
    expect(screen.getByText(content.actorStatus.run)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: content.pause })).toBeInTheDocument();
    expect(request.mock.calls.some(([, options]) => options?.method)).toBe(false);
  });
  it('保存已提交但响应丢失时，取消编辑会重新读取已保存布局', async () => {
    const feedback = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, feedback);
    let saved = state;
    const request = vi.fn().mockImplementation(async (path, options) => {
      if (path === '/camp') return camp;
      if (options?.method === 'PUT') { saved = { ...state, version: 2, placements: options.body.placements }; throw new Error('response lost'); }
      return saved;
    });
    render(<IslandPage client={{ request }} session={{ ...testSession, timezone: 'Asia/Taipei' }} />);
    fireEvent.click(await screen.findByRole('button', { name: content.edit }));
    fireEvent.click(screen.getAllByRole('button', { name: `${content.place} 树木` })[0]!);
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: content.cancel }));
    await waitFor(() => expect(request.mock.calls.filter(([path, options]) => path === '/island' && options?.method !== 'PUT')).toHaveLength(2));
    expect(document.querySelectorAll('[data-placement-id="tree-1"]')).toHaveLength(1);
    expect(feedback).not.toHaveBeenCalled();
    window.removeEventListener(FEEDBACK_EVENT, feedback);
  });
  it('购买实例按件摆放，保存失败保留草稿，重试成功后退出布置', async () => {
    const feedback = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, feedback);
    let fail = true;
    const request = vi.fn().mockImplementation(async (path, options) => {
      if (path === '/camp') return camp;
      if (options?.method === 'PUT') {
        if (fail) throw new Error('offline');
        return { ...state, version: 2, placements: options.body.placements };
      }
      return state;
    });
    render(<IslandPage client={{ request }} session={{ ...testSession, timezone: 'Asia/Taipei' }} />);
    fireEvent.click(await screen.findByRole('button', { name: content.edit }));
    const buttons = screen.getAllByRole('button', { name: `${content.place} 树木` });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(screen.getAllByRole('button', { name: `${content.place} 树木` })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByRole('alert');
    expect(screen.getAllByRole('button', { name: `${content.place} 树木` })).toHaveLength(1);
    expect(feedback).not.toHaveBeenCalled();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    expect(await screen.findByText(content.saved)).toHaveClass('feedback-success');
    expect(feedback).toHaveBeenCalledTimes(1);
    expect(feedback.mock.calls[0]?.[0].detail).toBe('island-save');
    window.removeEventListener(FEEDBACK_EVENT, feedback);
    expect(screen.getByRole('button', { name: content.edit })).toBeInTheDocument();
    const writes = request.mock.calls.filter(([, options]) => options?.method === 'PUT');
    expect(writes).toHaveLength(2);
    expect(writes[1]?.[1].body.placements.filter((item: { item_key: string }) => item.item_key === 'tree')).toHaveLength(1);
    const tree = writes[1]?.[1].body.placements.find((item: { item_key: string }) => item.item_key === 'tree');
    const house = state.placements.find((item) => item.item_key === 'house')!;
    expect(tree.y).toBeGreaterThanOrEqual(interactionPoint(house, state.catalog.find((item) => item.key === 'house')!).y);
  });
  it('版本冲突保留草稿直到明确取消并重载，静态物品没有互动按钮', async () => {
    const request = vi.fn().mockImplementation(async (path, options) => {
      if (path === '/camp') return camp;
      if (options?.method === 'PUT') throw new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: 'test' });
      return state;
    });
    render(<IslandPage client={{ request }} session={{ ...testSession, timezone: 'Asia/Taipei' }} />);
    fireEvent.click(await screen.findByRole('button', { name: content.edit }));
    fireEvent.click(screen.getAllByRole('button', { name: `${content.place} 树木` })[0]!);
    expect(screen.getByRole('button', { name: content.store })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByText(content.conflict);
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.reloadAfterCancel }));
    await waitFor(() => expect(screen.getByRole('button', { name: content.edit })).toBeInTheDocument());
  });
});

describe('全屏返回与布置草稿', () => {
  it('没有改动时返回直接离开；有改动时保存失败不会导航', async () => {
    const onBack = vi.fn();
    const onShop = vi.fn();
    const request = vi.fn().mockImplementation(async (path, options) => {
      if (path === '/camp') return camp;
      if (options?.method === 'PUT') throw new Error('offline');
      return state;
    });
    render(<IslandPage client={{ request }} session={{ ...testSession, timezone: 'Asia/Taipei' }} onBack={onBack} onShop={onShop} />);
    fireEvent.click(await screen.findByRole('button', { name: content.edit }));
    fireEvent.click(screen.getByRole('button', { name: content.back }));
    expect(onBack).toHaveBeenCalledOnce();
    fireEvent.click(screen.getAllByRole('button', { name: `${content.place} 树木` })[0]!);
    fireEvent.click(screen.getByRole('button', { name: content.shop }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: content.saveAndLeave }));
    await screen.findByRole('alert');
    expect(onShop).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.discardAndLeave }));
    expect(onShop).toHaveBeenCalledOnce();
  });
});


describe('小岛打卡与钱包', () => {
  it('显示余额和今日任务，折叠后隐藏项目，点击项目进入营地', async () => {
    const onCamp = vi.fn();
    const request = vi.fn().mockImplementation(async (path) => path === '/camp' ? { ...campFixture, wallet: { coins: 123, diamonds: 7, version: 1 } } : state);
    render(<IslandPage client={{ request }} session={{ ...testSession, timezone: 'Asia/Taipei' }} onCamp={onCamp} />);
    const task = await screen.findByRole('button', { name: '阅读' });
    expect(task.textContent).toBe('');
    expect(within(screen.getByRole('banner')).getByRole('button', { name: content.edit })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起今日打卡' }).textContent).toBe('');
    const balance = screen.getByRole('region', { name: '我的余额' });
    expect(within(balance).getByText('123')).toBeInTheDocument();
    expect(within(balance).getByText('7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '收起今日打卡' }));
    expect(task).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开今日打卡' }));
    fireEvent.click(screen.getByRole('button', { name: '阅读' }));
    expect(onCamp).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });
  it('打卡入口沿用未保存保护，失败不离开，放弃后进入营地', async () => {
    const onCamp = vi.fn();
    const request = vi.fn().mockImplementation(async (path, options) => {
      if (path === '/camp') return campFixture;
      if (options?.method === 'PUT') throw new Error('offline');
      return state;
    });
    render(<IslandPage client={{ request }} session={{ ...testSession, timezone: 'Asia/Taipei' }} onCamp={onCamp} />);
    fireEvent.click(await screen.findByRole('button', { name: content.edit }));
    fireEvent.click(screen.getAllByRole('button', { name: `${content.place} 树木` })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '展开今日打卡' }));
    fireEvent.click(screen.getByRole('button', { name: '阅读' }));
    fireEvent.click(await screen.findByRole('button', { name: content.saveAndLeave }));
    await screen.findByRole('alert');
    expect(onCamp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: content.discardAndLeave }));
    expect(onCamp).toHaveBeenCalledOnce();
  });
  it.each([false, true])('没有可打卡任务时说明状态，不制造空任务按钮 (%s)', async (scheduled) => {
    const request = vi.fn().mockImplementation(async (path) => path === '/camp' ? { ...camp, has_scheduled_tasks: scheduled } : state);
    render(<IslandPage client={{ request }} session={{ ...testSession, timezone: 'Asia/Taipei' }} onCamp={vi.fn()} />);
    expect(await screen.findByText(scheduled ? '今天的打卡已完成' : '今天没有打卡项目')).toBeInTheDocument();
  });
});


describe('打卡解锁活动', () => {
  it('锁定入口说明关联任务，不能启动，前台刷新后可以活动', async () => {
    let unlocked = false;
    const locked = { ...state, activity_access: state.activity_access.map((entry) => entry.activity === 'run'
      ? { ...entry, available: false, tasks: [{ id: 'exercise', name: '晨间运动', enabled: true }] } : entry) };
    const request = vi.fn().mockImplementation(async (path) => path === '/camp' ? camp : unlocked ? state : locked);
    const onCamp = vi.fn();
    const session = { ...testSession, timezone: 'Asia/Taipei' as const, account: { ...testSession.account, preferences: { ...testSession.account.preferences, reduce_motion: true } } };
    render(<IslandPage client={{ request }} session={session} onCamp={onCamp}/>);
    const button = await screen.findByRole('button', { name: `${content.activities.run} 运动区，${content.activityLocked}` });
    fireEvent.click(button);
    expect(screen.getByText('晨间运动')).toBeInTheDocument();
    expect(screen.queryByText(content.actorStatus.run)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.goCheckin }));
    expect(onCamp).toHaveBeenCalledOnce();
    unlocked = true;
    fireEvent.focus(window);
    const openButton = await screen.findByRole('button', { name: `${content.activities.run} 运动区` });
    fireEvent.click(openButton);
    expect(screen.getByText(content.actorStatus.run)).toBeInTheDocument();
  });
  it('前台刷新失败保留布置草稿，可以重试资格', async () => {
    let fail = false;
    const request = vi.fn().mockImplementation(async (path) => {
      if (path === '/camp') return camp;
      if (fail) throw new Error('offline');
      return state;
    });
    render(<IslandPage client={{ request }} session={{ ...testSession, timezone: 'Asia/Taipei' }}/>);
    fireEvent.click(await screen.findByRole('button', { name: content.edit }));
    fireEvent.click(screen.getAllByRole('button', { name: `${content.place} 树木` })[0]!);
    fail = true;
    fireEvent.focus(window);
    await screen.findByText(content.accessRefreshFailed);
    expect(document.querySelector('[data-placement-id="tree-1"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: content.save })).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: content.retryAccess }));
    await waitFor(() => expect(screen.queryByText(content.accessRefreshFailed)).not.toBeInTheDocument());
    expect(document.querySelector('[data-placement-id="tree-1"]')).toBeInTheDocument();
  });
});


describe('小岛初次读取跨日', () => {
  it('营地先返回就校准时间，较晚的小岛响应不能倒拨到昨日', async () => {
    let time = Date.parse('2026-10-29T23:59:59+08:00');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    let resolveIsland!: (value: typeof state) => void;
    const oldIsland = new Promise<typeof state>((resolve) => { resolveIsland = resolve; });
    const linked = [{ activity: 'run' as const, available: true, tasks: [{ id: 't', name: '运动打卡', enabled: true }] }];
    const expired = { ...state, today: '2026-10-29', expires_at: '2026-10-30T00:00:00+08:00', activity_access: linked };
    const next = { ...expired, today: '2026-10-30', expires_at: '2026-10-31T00:00:00+08:00', activity_access: linked.map((entry) => ({ ...entry, available: false })) };
    const request = vi.fn().mockImplementation((path) => path === '/camp' ? Promise.resolve({ ...camp, server_now: '2026-10-29T23:59:59+08:00' }) : oldIsland);
    let offset = 0;
    const recordServerTime = vi.fn((serverNow: string) => { offset = Date.parse(serverNow) - Date.now(); });
    const client = { request, recordServerTime, now: () => new Date(Date.now() + offset) };
    const view = render(<IslandPage client={client} session={{ ...testSession, timezone: 'Asia/Taipei' }}/>);
    try {
      await act(async () => {});
      expect(recordServerTime).toHaveBeenCalledOnce();
      time += 5000;
      request.mockImplementation(async (path) => path === '/camp' ? camp : next);
      await act(async () => { resolveIsland(expired); });
      await screen.findByRole('button', { name: `${content.activities.run} 运动区，${content.activityLocked}` });
      expect(request.mock.calls.filter(([path]) => path === '/island')).toHaveLength(2);
      expect(recordServerTime).toHaveBeenCalledOnce();
    } finally { view.unmount(); clock.mockRestore(); }
  });
});
