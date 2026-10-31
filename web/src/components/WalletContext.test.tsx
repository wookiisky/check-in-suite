import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WalletProvider, useWallet } from './WalletContext';
import { GlobalWallet } from './GlobalWallet';
import type { ShopClient, Camp } from '../features/shop/types';
import { campFixture } from '../features/checkin/test-fixtures';
import { CHECKIN_SUCCESS_EVENT } from '../features/checkin/events';
import content from './content.json';

// 包装真实组件与Hook，金额只由服务端快照驱动。
function setup(client: ShopClient, reduceMotion = false) {
  return renderHook(() => useWallet(), { wrapper: ({ children }) => <WalletProvider client={client} active><GlobalWallet reduceMotion={reduceMotion} />{children}</WalletProvider> });
}

describe('全局钱包', () => {
  it('首次读取负余额和零余额，币种只用图标展示', async () => {
    setup({ request: vi.fn().mockResolvedValue({ ...campFixture, wallet: { coins: -12, diamonds: 0, version: 2 } }) });
    const wallet = await screen.findByRole('region', { name: content.walletBalance });
    await waitFor(() => expect(wallet.querySelectorAll('.currency-amount')[0]).toHaveTextContent('-12'));
    expect(wallet.querySelectorAll('.currency-amount')[1]).toHaveTextContent('0');
    expect(within(wallet).getByRole('img', { name: content.coins })).toBeInTheDocument();
    expect(within(wallet).getByRole('img', { name: content.diamonds })).toBeInTheDocument();
    expect(wallet).not.toHaveTextContent(/金币|钻石/);
  });

  it('迟到初始读取和旧成功回执不能覆盖更高版本余额', async () => {
    let complete!: (value: Camp) => void;
    const view = setup({ request: vi.fn().mockImplementation(() => new Promise<Camp>((resolve) => { complete = resolve; })) });
    act(() => view.result.current.updateWallet({ coins: 45, diamonds: 6, version: 5 }));
    act(() => view.result.current.updateWallet({ coins: 900, diamonds: 90, version: 1 }));
    await act(async () => complete({ ...campFixture, wallet: { coins: 10, diamonds: 1, version: 2 } }));
    expect(view.result.current.wallet).toEqual({ coins: 45, diamonds: 6, version: 5 });
  });

  it('初始读取失败显示未知金额，重试只读取钱包', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('读取失败')).mockResolvedValue(campFixture);
    const view = setup({ request });
    await screen.findByText(content.walletError);
    expect(view.result.current.wallet).toBeNull();
    expect(screen.getAllByText(content.unknownAmount)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: content.walletRetry }));
    await waitFor(() => expect(view.result.current.wallet).toEqual(campFixture.wallet));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('新打卡强调已确认余额，同一记录或普通刷新不重放', async () => {
    const view = setup({ request: vi.fn().mockResolvedValue(campFixture) });
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());
    act(() => view.result.current.updateWallet({ coins: 500, diamonds: 90, version: 2 }));
    act(() => window.dispatchEvent(new CustomEvent(CHECKIN_SUCCESS_EVENT, { detail: { recordId: 'confirmed-1', coins: 7, diamonds: 3 } })));
    const wallet = screen.getByRole('region', { name: content.walletBalance });
    expect(wallet.querySelectorAll('.feedback-pop')).toHaveLength(2);
    expect(wallet.querySelectorAll('.currency-amount')[0]).toHaveTextContent('500');
    for (const amount of wallet.querySelectorAll('.feedback-pop')) fireEvent(amount, new Event('webkitAnimationEnd', { bubbles: true }));
    expect(wallet.querySelector('.feedback-pop')).toBeNull();
    act(() => view.result.current.updateWallet({ coins: 500, diamonds: 90, version: 3 }));
    act(() => window.dispatchEvent(new CustomEvent(CHECKIN_SUCCESS_EVENT, { detail: { recordId: 'confirmed-1', coins: 7, diamonds: 3 } })));
    expect(wallet.querySelector('.feedback-pop')).toBeNull();
  });

  it('减少动效时保留金额且不强调', async () => {
    const view = setup({ request: vi.fn().mockResolvedValue(campFixture) }, true);
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());
    act(() => window.dispatchEvent(new CustomEvent(CHECKIN_SUCCESS_EVENT, { detail: { recordId: 'confirmed-2', coins: 7, diamonds: 3 } })));
    expect(screen.getByRole('region', { name: content.walletBalance }).querySelector('.feedback-pop')).toBeNull();
  });
});
