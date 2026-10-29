import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    expect(screen.getByText(content.staticItem)).toBeInTheDocument();
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
