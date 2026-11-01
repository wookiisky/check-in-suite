import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiFailure } from '../../api/client';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { ProductEditor } from './ProductEditor';
import { ProductManagement } from './ProductManagement';
import { AppearanceProvider } from '../character/AppearanceProvider';
import { deferred } from './appearance-test-fixtures';
import { managedTitle as product, productAssets as assets, productCatalog, managedWearable } from './product-management-fixtures';
import content from './content.json';

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

afterEach(() => vi.unstubAllGlobals());

describe('商品配置', () => {
  it('按定义部位选择服装并提交准确身份，默认款不售卖', async () => {
    const request = vi.fn().mockResolvedValue(managedWearable);
    render(<ProductEditor client={{ request }} session={session} product={null} assets={assets} characters={productCatalog.characters} wearables={productCatalog.wearables} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('option', { name: '动物形象' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(content.typeFilter), { target: { value: 'upper' } });
    expect(screen.queryByRole('option', { name: '上衣默认款' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '发型新款' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(content.asset), { target: { value: 'catalog-preview-q' } });
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '新的服装' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request.mock.calls[0]?.[1].body).toMatchObject({ type: 'wearable', asset_key: 'catalog-preview-q', wearable_key: 'catalog-choice-z' });
  });

  it('编辑已有服装保留定义身份，已有购买记录时只允许修改报价', async () => {
    const request = vi.fn().mockResolvedValue(managedWearable);
    render(<ProductEditor client={{ request }} session={session} product={{ ...managedWearable, owned_count: 2 }} assets={assets} characters={productCatalog.characters} wearables={productCatalog.wearables} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(content.typeFilter)).toHaveValue('upper');
    expect(screen.getByLabelText(content.typeFilter)).toBeDisabled();
    expect(screen.getByLabelText(content.asset)).toBeDisabled();
    fireEvent.change(screen.getByLabelText(content.coinPrice), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request.mock.calls[0]?.[1].body).toMatchObject({ wearable_key: 'catalog-choice-z', asset_key: 'catalog-preview-q', coin_price: 25, expected_version: 1 });
  });
  it('从共享目录取得定义后才能新增服装，失败重读恢复', async () => {
    let appearanceReads = 0;
    const waiting = deferred<typeof productCatalog>();
    const request = vi.fn(async (path: string) => {
      if (path === '/appearance') {
        appearanceReads += 1;
        if (appearanceReads === 1) throw new Error('catalog unavailable');
        return waiting.promise;
      }
      if (path === '/assets') return { items: assets };
      return { items: [managedWearable] };
    });
    const client = { request: request as ApiClient['request'] };
    render(<AppearanceProvider active client={client}><ProductManagement client={client} session={session} /></AppearanceProvider>);
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: content.addProduct })).toBeDisabled();
    expect(screen.getByRole('button', { name: `${content.edit} ${managedWearable.name}` })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.reload }));
    await waitFor(() => expect(appearanceReads).toBe(2));
    waiting.resolve(productCatalog);
    await waitFor(() => expect(screen.getByRole('button', { name: content.addProduct })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: content.addProduct }));
    fireEvent.change(screen.getByLabelText(content.typeFilter), { target: { value: 'upper' } });
    expect(screen.getByRole('option', { name: '森林款' })).toHaveValue('catalog-preview-q');
    expect(screen.queryByRole('option', { name: '上衣默认款' })).not.toBeInTheDocument();
  });

  it('改为非服装商品时清除服装身份，不沿用旧的 key', async () => {
    const request = vi.fn().mockResolvedValue(product);
    render(<ProductEditor client={{ request }} session={session} product={managedWearable} assets={assets} characters={productCatalog.characters} wearables={productCatalog.wearables} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.typeFilter), { target: { value: 'reward' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request.mock.calls[0]?.[1].body).toMatchObject({ type: 'reward', asset_key: 'reward-book-v1' });
    expect(request.mock.calls[0]?.[1].body.wearable_key).toBeUndefined();
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
    fireEvent.change(screen.getByLabelText(content.typeFilter), { target: { value: 'reward' } });
    expect(screen.getByLabelText(content.asset)).toHaveValue('reward-book-v1');
    expect(screen.queryByRole('option', { name: '皇冠' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '新奖励' } });
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
