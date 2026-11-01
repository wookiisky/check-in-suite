import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TitlePicker } from './TitlePicker';
import { appearanceClient, deferred } from '../shop/appearance-test-fixtures';
import { titlePurchase } from './character-panel-test-fixtures';
import { ApiFailure } from '../../api/client';
import type { components } from '../../api/schema';
import { FEEDBACK_EVENT } from '../../feedback/feedback-events';
import content from './title-picker-content.json';
import common from '../../content/zh-CN.json';

type Equipment = components['schemas']['Equipment'];

// 成功HTTP正文截断表示服务器可能已提交，不能当作确定的业务拒绝。
const lostReceipt = () => new ApiFailure(200, { code: 'INVALID_RESPONSE', field_errors: {}, request_id: '' });

describe('称号未知保存跨关闭恢复', () => {
  it('提交后断回执关闭重开，先读事实再发布，不重复PUT或装备反馈', async () => {
    const fact = deferred<{ equipment: Equipment }>(); const saved = vi.fn(); const close = vi.fn(); const feedback = vi.fn();
    let server: Equipment = { title: null };
    const { client, request } = appearanceClient(async (path) => {
      if (path.startsWith('/purchases?')) return { items: [titlePurchase], next_cursor: null };
      if (path === '/equipment/title') { server = { title: titlePurchase }; throw lostReceipt(); }
      if (path === '/camp') return fact.promise;
      throw new Error(path);
    });
    window.addEventListener(FEEDBACK_EVENT, feedback);
    try {
      const first = render(<TitlePicker client={client} equipment={{ title: null }} onClose={close} onSaved={saved} />);
      fireEvent.click(await screen.findByRole('button', { name: `${content.equip} ${titlePurchase.name_snapshot}` }));
      await screen.findByText(content.unknown);
      expect(saved).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: content.retrySave })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: common.common.close })); expect(close).toHaveBeenCalledOnce(); first.unmount();
      render(<TitlePicker client={client} equipment={{ title: null }} onClose={close} onSaved={saved} />);
      await waitFor(() => expect(request.mock.calls.some(([path]) => path === '/camp')).toBe(true));
      expect(screen.queryByRole('button', { pressed: true })).toBeNull();
      expect(await screen.findByRole('button', { name: `${content.awaitingResult} ${titlePurchase.name_snapshot}` })).toBeDisabled();
      await act(async () => fact.resolve({ equipment: server }));
      await waitFor(() => expect(saved).toHaveBeenCalledWith(server));
      expect(screen.getByRole('button', { name: `${content.unequip} ${titlePurchase.name_snapshot}` })).toHaveAttribute('aria-pressed', 'true');
      expect(request.mock.calls.filter(([path]) => path === '/equipment/title')).toHaveLength(1);
      expect(feedback).not.toHaveBeenCalled();
    } finally { window.removeEventListener(FEEDBACK_EVENT, feedback); }
  });

  it('读取失败跨重开保持阻塞，确认当前不同后才允许显式重试原目标', async () => {
    let readFails = true; let writeFails = true; const saved = vi.fn();
    const { client, request } = appearanceClient(async (path) => {
      if (path.startsWith('/purchases?')) return { items: [titlePurchase], next_cursor: null };
      if (path === '/equipment/title') { if (writeFails) throw new TypeError('offline'); return { title: titlePurchase }; }
      if (path === '/camp') { if (readFails) throw new TypeError('offline'); return { equipment: { title: null } }; }
      throw new Error(path);
    });
    const first = render(<TitlePicker client={client} equipment={{ title: null }} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.click(await screen.findByRole('button', { name: `${content.equip} ${titlePurchase.name_snapshot}` }));
    fireEvent.click(await screen.findByRole('button', { name: content.readResult }));
    await waitFor(() => expect(screen.getByRole('button', { name: content.readResult })).toBeEnabled());
    expect(screen.getByRole('button', { name: `${content.awaitingResult} ${titlePurchase.name_snapshot}` })).toBeDisabled();
    first.unmount();
    render(<TitlePicker client={client} equipment={{ title: null }} onClose={vi.fn()} onSaved={saved} />);
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path === '/camp')).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', { name: content.readResult })).toBeEnabled());
    expect(screen.queryByRole('button', { name: content.retrySave })).toBeNull();
    readFails = false; fireEvent.click(screen.getByRole('button', { name: content.readResult }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ title: null }));
    expect(request.mock.calls.filter(([path]) => path === '/equipment/title')).toHaveLength(1);
    writeFails = false; fireEvent.click(screen.getByRole('button', { name: content.retrySave }));
    await waitFor(() => expect(saved).toHaveBeenLastCalledWith({ title: titlePurchase }));
    expect(request.mock.calls.filter(([path]) => path === '/equipment/title')).toHaveLength(2);
  });

  it('关闭取消核对读取，迟到结果不能覆盖重开后的事实', async () => {
    const late = deferred<{ equipment: Equipment }>(); const latest = deferred<{ equipment: Equipment }>(); const saved = vi.fn();
    let reads = 0;
    const { client, request } = appearanceClient(async (path) => {
      if (path.startsWith('/purchases?')) return { items: [titlePurchase], next_cursor: null };
      if (path === '/equipment/title') throw lostReceipt();
      if (path === '/camp') return ++reads === 1 ? late.promise : latest.promise;
      throw new Error(path);
    });
    const first = render(<TitlePicker client={client} equipment={{ title: null }} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.click(await screen.findByRole('button', { name: `${content.equip} ${titlePurchase.name_snapshot}` }));
    fireEvent.click(await screen.findByRole('button', { name: content.readResult }));
    const signal = request.mock.calls.find(([path]) => path === '/camp')?.[1]?.signal;
    first.unmount(); expect(signal?.aborted).toBe(true);
    render(<TitlePicker client={client} equipment={{ title: null }} onClose={vi.fn()} onSaved={saved} />);
    await act(async () => latest.resolve({ equipment: { title: null } }));
    await act(async () => late.resolve({ equipment: { title: titlePurchase } }));
    expect(saved).toHaveBeenCalledExactlyOnceWith({ title: null });
    expect(screen.queryByRole('button', { pressed: true })).toBeNull();
    expect(request.mock.calls.filter(([path]) => path === '/equipment/title')).toHaveLength(1);
  });
});
