import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../api/client';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { CampPage } from './CampPage';
import { CheckinComposer } from './CheckinComposer';
import { RecordDialog } from './RecordDialog';
import { ShopPage } from '../shop/ShopPage';
import { PurchaseDialog } from '../shop/PurchaseDialog';
import { campFixture, recordFixture, taskFixture } from './test-fixtures';
import { camp, product, purchase, wallet } from '../shop/test-fixtures';
import checkinContent from './content.json';
import shopContent from '../shop/content.json';

const session = testSession as Session;
const publish = vi.hoisted(() => vi.fn());
vi.mock('../../components/WalletContext', () => ({ useWalletSync: () => publish }));
beforeEach(() => publish.mockReset());

// 读取和写入在实际成功边界发布钱包，不从奖励、价格或前端余额差推算。
describe('全局钱包同步边界', () => {
  it('首页读取发布准确负余额，但不再渲染局部余额块', async () => {
    const snapshot = { ...campFixture, wallet: { coins: -12, diamonds: 0, version: 2 } };
    const request = vi.fn().mockImplementation(async (path: string) => path === '/camp' ? snapshot : { items: [], next_cursor: null });
    render(<CampPage client={{ request }} session={session} />);
    await screen.findByRole('button', { name: /阅读/ });
    expect(publish).toHaveBeenCalledWith(snapshot.wallet);
    expect(screen.queryByLabelText(checkinContent.balance)).not.toBeInTheDocument();
  });

  it('商店读取发布钱包，页面只保留商品价格和购买确认', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path === '/camp' ? camp : { items: [product] });
    render(<ShopPage client={{ request }} session={session} />);
    await screen.findByRole('button', { name: `${shopContent.buy} ${product.name}` });
    expect(publish).toHaveBeenCalledWith(camp.wallet);
    expect(screen.queryByLabelText(shopContent.balance)).not.toBeInTheDocument();
  });

  it.each([false, true])('普通或管理打卡只在服务端成功后发布回执钱包（管理：%s）', async (management) => {
    const receipt = { checkin: recordFixture, wallet: { coins: 123, diamonds: 45, version: 4 }, task_remaining: 1, today: testSession.today };
    const request = vi.fn().mockRejectedValueOnce(new ApiFailure(0, { code: 'NETWORK_ERROR', field_errors: {}, request_id: '' })).mockResolvedValueOnce(receipt);
    render(<CheckinComposer client={{ request }} session={session} task={taskFixture} date={testSession.today} management={management} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: checkinContent.checkin }));
    await screen.findByText(checkinContent.unknownResult);
    expect(publish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: checkinContent.recover }));
    await waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith(receipt.wallet));
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
  });

  it.each([false, true])('普通或管理删除发布回收后的钱包（管理：%s）', async (management) => {
    const receipt = { deleted: true, wallet: { coins: -1, diamonds: 0, version: 8 } };
    const request = vi.fn().mockResolvedValue(receipt);
    const onSaved = vi.fn();
    render(<RecordDialog client={{ request }} session={session} record={recordFixture} today={testSession.today} management={management} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: checkinContent.delete }));
    fireEvent.click(screen.getByRole('button', { name: checkinContent.confirmDelete }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(publish).toHaveBeenCalledExactlyOnceWith(receipt.wallet);
  });

  it('删除拒绝时不发布或推算余额', async () => {
    const request = vi.fn().mockRejectedValue(new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' }));
    render(<RecordDialog client={{ request }} session={session} record={recordFixture} today={testSession.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: checkinContent.delete }));
    fireEvent.click(screen.getByRole('button', { name: checkinContent.confirmDelete }));
    await screen.findByRole('alert');
    expect(publish).not.toHaveBeenCalled();
  });

  it('购买结果未知时不改余额，原请求恢复成功才发布回执', async () => {
    const receipt = { purchase, wallet: { coins: 17, diamonds: 9, version: 6 } };
    const request = vi.fn().mockRejectedValueOnce(new ApiFailure(0, { code: 'NETWORK_ERROR', field_errors: {}, request_id: '' })).mockResolvedValueOnce(receipt);
    render(<PurchaseDialog client={{ request }} product={product} wallet={wallet} onClose={vi.fn()} onPurchased={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: shopContent.confirmPurchase }));
    await screen.findByText(shopContent.purchasePending);
    expect(publish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: shopContent.recoverPurchase }));
    await waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith(receipt.wallet));
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
  });

  it('报价冲突后取得新钱包，即使商品已下架也发布当前余额', async () => {
    const snapshot = { ...camp, wallet: { coins: 44, diamonds: 7, version: 3 } };
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') throw new ApiFailure(409, { code: 'PRODUCT_CHANGED', field_errors: {}, request_id: '' });
      return path === '/camp' ? snapshot : { items: [] };
    });
    render(<PurchaseDialog client={{ request }} product={product} wallet={wallet} onClose={vi.fn()} onPurchased={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: shopContent.confirmPurchase }));
    fireEvent.click(await screen.findByRole('button', { name: shopContent.refreshOffer }));
    await within(screen.getByRole('dialog')).findByText(shopContent.purchaseClosed);
    expect(publish).toHaveBeenCalledExactlyOnceWith(snapshot.wallet);
  });
});
