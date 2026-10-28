import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiFailure } from '../../api/client';
import { PurchaseDialog } from './PurchaseDialog';
import { CharacterPanel } from './CharacterPanel';
import { Wardrobe } from './Wardrobe';
import { RedeemDialog } from './RedeemDialog';
import { camp, equipment, product, purchase, wallet } from './test-fixtures';
import type { ShopClient } from './types';
import content from './content.json';

afterEach(() => vi.unstubAllGlobals());

describe('购买确认与恢复', () => {
  it('真实201响应JSON截断后保留原命令，跨弹窗重放不重复购买文本奖励', async () => {
    const rewardProduct = {
      ...product,
      type: 'reward' as const,
      coin_price: 0,
      diamond_price: 0,
      stock: null,
    };
    const rewardPurchase = {
      ...purchase,
      type_snapshot: 'reward' as const,
      status: 'pending' as const,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"purchase":', {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(Response.json({ purchase: rewardPurchase, wallet }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new ApiClient();
    const onPurchased = vi.fn();
    const first = render(
      <PurchaseDialog
        client={client}
        product={rewardProduct}
        wallet={wallet}
        onClose={vi.fn()}
        onPurchased={onPurchased}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: content.confirmPurchase }));
    await screen.findByText(content.purchasePending);
    expect(onPurchased).not.toHaveBeenCalled();
    first.unmount();
    render(
      <PurchaseDialog
        client={client}
        product={{ ...rewardProduct, version: 7 }}
        wallet={{ ...wallet, version: 8 }}
        onClose={vi.fn()}
        onPurchased={onPurchased}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: content.recoverPurchase }));
    await waitFor(() => expect(onPurchased).toHaveBeenCalledWith(rewardPurchase));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstWrite = fetchMock.mock.calls[0]?.[1];
    const replay = fetchMock.mock.calls[1]?.[1];
    expect(replay?.body).toBe(firstWrite?.body);
    expect((replay?.headers as Headers).get('Idempotency-Key')).toBe(
      (firstWrite?.headers as Headers).get('Idempotency-Key'),
    );
    expect(JSON.parse(String(replay?.body))).toEqual({
      product_id: product.id,
      expected_product_version: 1,
      expected_wallet_version: 1,
    });
  });

  it('任一余额为负，即使免费也不允许购买', () => {
    render(
      <PurchaseDialog
        client={{ request: vi.fn() }}
        product={{ ...product, coin_price: 0, diamond_price: 0 }}
        wallet={{ ...wallet, coins: -1 }}
        onClose={vi.fn()}
        onPurchased={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: content.confirmPurchase })).toBeDisabled();
    expect(screen.getByText(content.insufficient)).toBeInTheDocument();
  });

  it('购买结果未知后关闭重开仍用原键原请求核对，成功不自动装备', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiFailure(0, { code: 'NETWORK_ERROR', field_errors: {}, request_id: '' }),
      )
      .mockResolvedValueOnce({ purchase, wallet });
    const client: ShopClient = { request };
    const onPurchased = vi.fn();
    const first = render(
      <PurchaseDialog
        client={client}
        product={product}
        wallet={wallet}
        onClose={vi.fn()}
        onPurchased={onPurchased}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: content.confirmPurchase }));
    await screen.findByText(content.purchasePending);
    first.unmount();
    render(
      <PurchaseDialog
        client={client}
        product={{ ...product, version: 9 }}
        wallet={{ ...wallet, version: 9 }}
        onClose={vi.fn()}
        onPurchased={onPurchased}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: content.recoverPurchase }));
    await waitFor(() => expect(onPurchased).toHaveBeenCalledWith(purchase));
    expect(request.mock.calls).toHaveLength(2);
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    expect(request.mock.calls[0]?.[1].body.expected_product_version).toBe(1);
  });

  it('价格变化后先读取最新价格与余额，用户再次确认才生成新命令', async () => {
    const changed = { ...product, coin_price: 12, version: 2 };
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiFailure(409, { code: 'PRODUCT_CHANGED', field_errors: {}, request_id: '' }),
      )
      .mockImplementation(async (path: string) =>
        path === '/products'
          ? { items: [changed] }
          : path === '/camp'
            ? { ...camp, wallet: { ...wallet, version: 2 } }
            : { purchase, wallet },
      );
    render(
      <PurchaseDialog
        client={{ request }}
        product={product}
        wallet={wallet}
        onClose={vi.fn()}
        onPurchased={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: content.confirmPurchase }));
    await screen.findByRole('button', { name: content.refreshOffer });
    expect(screen.getByRole('button', { name: content.confirmPurchase })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.refreshOffer }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: content.confirmPurchase })).toBeEnabled(),
    );
    expect(request.mock.calls.filter(([path]) => path === '/purchases')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: content.confirmPurchase }));
    await waitFor(() =>
      expect(request.mock.calls.filter(([path]) => path === '/purchases')).toHaveLength(2),
    );
    const writes = request.mock.calls.filter(([path]) => path === '/purchases');
    expect(writes[1]?.[1].body.expected_product_version).toBe(2);
    expect(writes[1]?.[1].body.expected_wallet_version).toBe(2);
    expect(writes[1]?.[1].idempotencyKey).not.toBe(writes[0]?.[1].idempotencyKey);
  });
});

describe('所有权、装扮与兑现', () => {
  it('十个饰品都使用实际SVG展示，默认角色仍可见', () => {
    const full = {
      ...equipment,
      accessories: Array.from({ length: 10 }, (_, i) => ({
        ...purchase,
        id: `p${i}`,
        name_snapshot: `饰品${i}`,
      })),
    };
    render(<CharacterPanel equipment={full} displayName="小朋友" />);
    expect(screen.getByAltText(content.defaultAvatar)).toHaveAttribute(
      'src',
      '/api/v1/assets/fox-v1',
    );
    for (const item of full.accessories)
      expect(screen.getByAltText(item.name_snapshot)).toHaveAttribute(
        'src',
        '/api/v1/assets/accessory-star-v1',
      );
  });

  it('十个饰品时不能装备第十一个，但可以逐件卸下现有饰品', () => {
    const full = {
      ...equipment,
      accessories: Array.from({ length: 10 }, (_, i) => ({
        ...purchase,
        id: `p${i}`,
        name_snapshot: `饰品${i}`,
      })),
    };
    const onToggle = vi.fn();
    render(
      <Wardrobe
        items={[...full.accessories, { ...purchase, id: 'extra', name_snapshot: '额外饰品' }]}
        equipment={full}
        busy={false}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByRole('button', { name: `${content.equip} 额外饰品` })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: `${content.unequip} 饰品0` }));
    expect(onToggle).toHaveBeenCalledWith(full.accessories[0], false);
  });

  it('每次兑现都提交本次密码，错误密码保留表单重试', async () => {
    const reward = { ...purchase, type_snapshot: 'reward' as const, status: 'pending' as const };
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiFailure(422, { code: 'INVALID_CREDENTIALS', field_errors: {}, request_id: '' }),
      )
      .mockResolvedValueOnce({ ...reward, status: 'redeemed' });
    const onRedeemed = vi.fn();
    render(
      <RedeemDialog
        client={{ request }}
        purchase={reward}
        onClose={vi.fn()}
        onRedeemed={onRedeemed}
      />,
    );
    fireEvent.change(screen.getByLabelText(content.redeemPassword), {
      target: { value: 'wrong password' },
    });
    fireEvent.click(screen.getByRole('button', { name: content.confirmRedeem }));
    await screen.findByText(content.errors.INVALID_CREDENTIALS);
    expect(screen.getByLabelText(content.redeemPassword)).toHaveValue('wrong password');
    fireEvent.change(screen.getByLabelText(content.redeemPassword), {
      target: { value: 'correct password' },
    });
    fireEvent.click(screen.getByRole('button', { name: content.confirmRedeem }));
    await waitFor(() => expect(onRedeemed).toHaveBeenCalled());
    expect(request.mock.calls[1]).toEqual([
      `/purchases/${purchase.id}/redeem`,
      { method: 'POST', body: { password: 'correct password' } },
    ]);
  });
});
