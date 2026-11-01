import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TitlePicker } from './TitlePicker';
import { appearanceClient, deferred } from '../shop/appearance-test-fixtures';
import { titlePurchase } from './character-panel-test-fixtures';
import type { components } from '../../api/schema';
import content from './title-picker-content.json';
import common from '../../content/zh-CN.json';
import { ApiFailure } from '../../api/client';

type Equipment = components['schemas']['Equipment'];

describe('独立称号选择', () => {
  it('分页加载已购称号，以保存响应更新并支持卸下，不传账户版本', async () => {
    const saved = vi.fn(); const close = vi.fn(); const writing = deferred<Equipment>();
    const second = { ...titlePurchase, id: 'other-title', name_snapshot: '第二称号' };
    const { client, request } = appearanceClient(async (path, options) => {
      if (path.includes('cursor=')) return { items: [second], next_cursor: null };
      if (path.startsWith('/purchases?')) return { items: [titlePurchase], next_cursor: 'title-page' };
      if (path === '/equipment/title') return options.body && (options.body as { purchase_id: string | null }).purchase_id ? writing.promise : { title: null };
      throw new Error(path);
    });
    render(<TitlePicker client={client} equipment={{ title: null }} onClose={close} onSaved={saved} />);
    fireEvent.click(await screen.findByRole('button', { name: `${content.equip} ${titlePurchase.name_snapshot}` }));
    expect(screen.getByRole('button', { name: common.common.close })).toBeDisabled();
    await act(async () => writing.resolve({ title: titlePurchase }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ title: titlePurchase }));
    expect(request.mock.calls.find(([path]) => path === '/equipment/title')?.[1]).toEqual({ method: 'PUT', body: { purchase_id: titlePurchase.id } });
    fireEvent.click(screen.getByRole('button', { name: content.more }));
    await screen.findByRole('button', { name: `${content.equip} ${second.name_snapshot}` });
    fireEvent.click(screen.getByRole('button', { name: `${content.unequip} ${titlePurchase.name_snapshot}` }));
    await waitFor(() => expect(saved).toHaveBeenLastCalledWith({ title: null }));
    expect(request.mock.calls.filter(([path]) => path === '/equipment')).toHaveLength(0);
  });

  it('写失败保留已保存选择，重试后才发布', async () => {
    let fail = true; const saved = vi.fn();
    const { client, request } = appearanceClient(async (path) => {
      if (path.startsWith('/purchases?')) return { items: [titlePurchase], next_cursor: null };
      if (path === '/equipment/title') { if (fail) throw new ApiFailure(400, { code: 'INVALID_REQUEST', field_errors: {}, request_id: '' }); return { title: null }; }
      throw new Error(path);
    });
    render(<TitlePicker client={client} equipment={{ title: titlePurchase }} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.click(await screen.findByRole('button', { name: `${content.unequip} ${titlePurchase.name_snapshot}` }));
    await screen.findByRole('alert');
    expect(saved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: `${content.unequip} ${titlePurchase.name_snapshot}` })).toBeEnabled();
    fail = false; fireEvent.click(screen.getByRole('button', { name: content.retrySave }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ title: null }));
    expect(request.mock.calls.filter(([path]) => path === '/equipment/title')).toHaveLength(2);
  });

  it('初读和后续页分别重试，不把部分列表当作完整库存', async () => {
    let firstFailed = true; let moreFailed = true;
    const second = { ...titlePurchase, id: 'second', name_snapshot: '分页称号' };
    const { client } = appearanceClient(async (path) => {
      if (path.includes('cursor=')) { if (moreFailed) throw new Error('offline'); return { items: [titlePurchase, second], next_cursor: null }; }
      if (firstFailed) throw new Error('offline');
      return { items: [titlePurchase], next_cursor: 'next' };
    });
    render(<TitlePicker client={client} equipment={{ title: null }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByRole('alert');
    expect(screen.queryByText(content.empty)).toBeNull();
    firstFailed = false; fireEvent.click(screen.getByRole('button', { name: content.retry }));
    fireEvent.click(await screen.findByRole('button', { name: content.more }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: `${content.equip} ${titlePurchase.name_snapshot}` })).toBeEnabled();
    moreFailed = false; fireEvent.click(screen.getByRole('button', { name: content.retryMore }));
    await screen.findByRole('button', { name: `${content.equip} ${second.name_snapshot}` });
    expect(screen.getAllByRole('button', { name: `${content.equip} ${titlePurchase.name_snapshot}` })).toHaveLength(1);
  });

  it('已佩戴称号在后续页或商品下架时仍可直接卸下', async () => {
    const saved = vi.fn();
    const { client } = appearanceClient(async (path) => path === '/equipment/title' ? { title: null } : { items: [], next_cursor: 'later-page' });
    render(<TitlePicker client={client} equipment={{ title: titlePurchase }} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.click(await screen.findByRole('button', { name: `${content.unequip} ${titlePurchase.name_snapshot}` }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ title: null }));
  });

  it('卸载取消读取，迟到分页不发布装备', async () => {
    const page = deferred<unknown>(); const saved = vi.fn();
    const { client, request } = appearanceClient(async () => page.promise);
    const view = render(<TitlePicker client={client} equipment={{ title: null }} onClose={vi.fn()} onSaved={saved} />);
    const signal = request.mock.calls[0]![1]?.signal;
    view.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => page.resolve({ items: [titlePurchase], next_cursor: null }));
    expect(saved).not.toHaveBeenCalled();
  });
});
