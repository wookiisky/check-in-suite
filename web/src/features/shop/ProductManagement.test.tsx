import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiFailure } from '../../api/client';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { ProductEditor } from './ProductEditor';
import { product } from './test-fixtures';
import type { Asset } from './types';
import content from './content.json';

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };
const assets: Asset[] = [
  {
    key: 'accessory-star-v1',
    name: '星星',
    kind: 'accessory',
    url: '/api/v1/assets/accessory-star-v1',
  },
  { key: 'fox-v1', name: '狐狸', kind: 'avatar', url: '/api/v1/assets/fox-v1' },
  { key: 'title-crown-v1', name: '皇冠', kind: 'title', url: '/api/v1/assets/title-crown-v1' },
];

afterEach(() => vi.unstubAllGlobals());

describe('商品配置', () => {
  it('发型按独立类别选素材但仍提交饰品交易类型，免费人物不售卖', async () => {
    const request = vi.fn().mockResolvedValue(product);
    const wearableAssets: Asset[] = [...assets,
      { key: 'avatar-boy-v2', name: '免费男孩', kind: 'avatar', free: true, url: '/api/v1/assets/avatar-boy-v2' },
      { key: 'hair-curly-v1', name: '卷发', kind: 'accessory', wearable_slot: 'hair', url: '/api/v1/assets/hair-curly-v1' },
      { key: 'wearable-top-explorer-v1', name: '探险上装', kind: 'accessory', wearable_slot: 'top', url: '/api/v1/assets/wearable-top-explorer-v1' },
    ];
    render(<ProductEditor client={{ request }} session={session} product={null} assets={wearableAssets} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.typeFilter), { target: { value: 'avatar' } });
    expect(screen.queryByRole('option', { name: '免费男孩' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(content.typeFilter), { target: { value: 'hair' } });
    expect(screen.getByLabelText(content.asset)).toHaveValue('hair-curly-v1');
    expect(screen.queryByRole('option', { name: '探险上装' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '星星' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '新发型' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request.mock.calls[0]?.[1].body).toMatchObject({ type: 'accessory', asset_key: 'hair-curly-v1' });
  });
  it('真实201新增响应截断后跨弹窗恢复同一商品命令', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"id":', { status: 201, headers: { 'Content-Type': 'application/json' } }),
      )
      .mockResolvedValueOnce(Response.json(product, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new ApiClient();
    const onSaved = vi.fn();
    const first = render(
      <ProductEditor
        client={client}
        session={session}
        product={null}
        assets={assets}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '新增称号' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByText(content.createPending);
    expect(onSaved).not.toHaveBeenCalled();
    first.unmount();
    render(
      <ProductEditor
        client={client}
        session={session}
        product={null}
        assets={assets}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    expect(screen.getByLabelText(content.name)).toHaveValue('新增称号');
    expect(screen.getByLabelText(content.name)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.recoverCreate }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(product));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstWrite = fetchMock.mock.calls[0]?.[1];
    const replay = fetchMock.mock.calls[1]?.[1];
    expect(replay?.body).toBe(firstWrite?.body);
    expect((replay?.headers as Headers).get('Idempotency-Key')).toBe(
      (firstWrite?.headers as Headers).get('Idempotency-Key'),
    );
  });

  it('素材选择只展示当前商品种类，库存不限量传null且创建未知后复用原键', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiFailure(0, { code: 'NETWORK_ERROR', field_errors: {}, request_id: '' }),
      )
      .mockResolvedValueOnce(product);
    const onSaved = vi.fn();
    render(
      <ProductEditor
        client={{ request }}
        session={session}
        product={null}
        assets={assets}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText(content.typeFilter), { target: { value: 'avatar' } });
    expect(screen.getByLabelText(content.asset)).toHaveValue('fox-v1');
    expect(screen.queryByRole('option', { name: '星星' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '新形象' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByText(content.createPending);
    expect(screen.getByLabelText(content.name)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.recoverCreate }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
    expect(request.mock.calls[0]?.[1].body.stock).toBeNull();
  });

  it('编辑版本冲突保留草稿，读取当前配置后明确确认才能按新版本提交', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' }),
      )
      .mockResolvedValueOnce({ items: [{ ...product, version: 2, name: '别处改名' }] })
      .mockResolvedValueOnce(product);
    render(
      <ProductEditor
        client={{ request }}
        session={session}
        product={product}
        assets={assets}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '我的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByRole('button', { name: content.reloadProduct });
    fireEvent.click(screen.getByRole('button', { name: content.reloadProduct }));
    await screen.findByText(content.reviewProduct);
    expect(screen.getByLabelText(content.name)).toHaveValue('我的草稿');
    expect(request).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: content.confirmDraft }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[2]?.[1].body.expected_version).toBe(2);
    expect(request.mock.calls[2]?.[1].body.name).toBe('我的草稿');
  });
});
