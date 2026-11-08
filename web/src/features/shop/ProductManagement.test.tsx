import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiFailure } from '../../api/client';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { ProductEditor } from './ProductEditor';
import { ProductManagement } from './ProductManagement';
import { pendingProducts } from './pending';
import type { Product } from './types';
import { managedWearable as product, managedMaterials, managedMaterial } from './product-management-fixtures';
import content from './content.json';

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

afterEach(() => vi.unstubAllGlobals());

describe('商品配置', () => {
  it('按商店分组和子类请求后端，保留停用商品并提供分页', async () => {
    const furniture = { ...product, type: 'island', name: '营地长椅', enabled: false };
    const request = vi.fn(async (path: string) => {
      const query = new URL(path, 'http://fixture').searchParams;
      if (query.get('group') === 'appearance') return { items: [product] };
      return {
        items: query.get('cursor') ? [] : [furniture],
        camp_categories: ['scene', 'furniture'],
        next_cursor: query.get('cursor') ? null : 'more',
      };
    });
    render(<ProductManagement client={{ request: request as ApiClient['request'] }} session={session} />);
    await screen.findByRole('heading', { name: product.name });
    fireEvent.click(screen.getByRole('tab', { name: content.shopCamp }));
    fireEvent.click(await screen.findByRole('tab', { name: content.campCategories.furniture }));
    expect(await screen.findByText(content.unavailable)).toBeVisible();
    expect(screen.queryByRole('button', { name: /删除/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.more }));
    await waitFor(() => {
      const query = new URL(request.mock.lastCall![0], 'http://fixture').searchParams;
      expect(Object.fromEntries(query)).toMatchObject({ group: 'camp', category: 'furniture', include_inactive: 'true', cursor: 'more' });
    });
  });

  it('切换商品分组清除分组专属的来源和素材包筛选，保留搜索', async () => {
    const request = vi.fn(async (path: string) => {
      const group = new URL(path, 'http://fixture').searchParams.get('group');
      return {
        items: [],
        facets: group === 'appearance'
          ? { providers: ['kaykit'], packs: [{ key: 'adventurers', provider: 'kaykit', name: 'Adventurers' }] }
          : { providers: ['kenney'], packs: [] },
      };
    });
    render(<ProductManagement client={{ request: request as ApiClient['request'] }} session={session} />);
    await screen.findByRole('option', { name: 'Adventurers' });
    fireEvent.change(screen.getByLabelText(content.searchLabel), { target: { value: '森林' } });
    fireEvent.click(screen.getByRole('button', { name: content.search }));
    fireEvent.change(screen.getByLabelText(content.providerLabel), { target: { value: 'kaykit' } });
    fireEvent.change(screen.getByLabelText(content.packLabel), { target: { value: 'adventurers' } });
    fireEvent.click(screen.getByRole('tab', { name: content.shopCamp }));
    await screen.findByRole('option', { name: 'Kenney' });
    const query = new URL(request.mock.lastCall![0], 'http://fixture').searchParams;
    expect(Object.fromEntries(query)).toEqual({ group: 'camp', include_inactive: 'true', limit: '48', search: '森林' });
    expect(screen.getByLabelText(content.providerLabel)).toHaveValue('');
    expect(screen.getByLabelText(content.packLabel)).toHaveValue('');
  });

  it('素材库用缩略图呈现绑定，只能从可售素材新增商品', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/management/materials') return managedMaterials;
      if (path === '/management/products') return product;
      return { items: [product] };
    });
    render(<ProductManagement client={{ request }} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: content.addProduct }));
    const choice = await screen.findByRole('button', { name: `${content.addProduct} ${managedMaterial.asset.name}` });
    const material = choice.closest('article')!;
    expect(material.querySelector('img')).toHaveAttribute('src', '/api/v1/assets/catalog-preview-q');
    expect(screen.queryByRole('button', { name: `${content.addProduct} 免费上装` })).not.toBeInTheDocument();
    fireEvent.click(choice);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText(content.name)).toHaveValue(managedMaterial.asset.name);
    expect(within(dialog).queryByLabelText('商品类型')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: content.save }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/management/products', {
      method: 'POST', idempotencyKey: expect.any(String),
      body: { asset_key: managedMaterial.asset.key, name: managedMaterial.asset.name, coin_price: 0, diamond_price: 0, stock: null, enabled: true },
    }));
    expect(screen.getByRole('tab', { name: content.productLibrary })).toHaveAttribute('aria-selected', 'true');
  });

  it('素材库展示动作片段、场景、人物和道具绑定', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path === '/management/materials' ? managedMaterials : { items: [] });
    render(<ProductManagement client={{ request }} session={session} />);
    fireEvent.click(screen.getByRole('tab', { name: content.materialLibrary }));
    fireEvent.click(await screen.findByRole('tab', { name: content.materialActivities }));
    expect(screen.getByText('Read_Seated')).toBeVisible();
    expect(screen.getByText('海边营地')).toBeVisible();
    expect(screen.getByText('人形')).toBeVisible();
    expect(screen.getByText('activity-reading-book-v1')).toBeVisible();
    expect(screen.queryByRole('button', { name: /新增商品/ })).not.toBeInTheDocument();
  });

  it('编辑未售商品也只提交报价字段，显示当前素材且允许库存为零', async () => {
    const request = vi.fn().mockResolvedValue(product);
    render(<ProductEditor client={{ request }} session={session} product={product} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole('img', { name: content.asset })).toHaveAttribute('src', '/api/v1/assets/catalog-preview-q');
    expect(screen.queryByLabelText('商品类型')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('商品描述')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(content.coinPrice), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText(content.finiteStock), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/management/products/${product.id}`, {
      method: 'PATCH',
      body: { name: product.name, coin_price: 25, diamond_price: product.diamond_price, stock: 0, enabled: true, expected_version: 1 },
    }));
  });

  it('真实 201 响应截断后跨弹窗恢复同一商品命令', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"id":', { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(Response.json(product, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new ApiClient();
    const onSaved = vi.fn();
    const props = { client, session, onClose: vi.fn(), onSaved };
    const first = render(<ProductEditor {...props} product={null} material={managedMaterial} />);
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '新上装' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByText(content.createPending);
    expect(onSaved).not.toHaveBeenCalled();
    first.unmount();

    render(<ProductEditor {...props} product={null} />);
    expect(screen.getByLabelText(content.name)).toHaveValue('新上装');
    expect(screen.getByLabelText(content.name)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.recoverCreate }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(product));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstWrite = fetchMock.mock.calls[0]?.[1];
    const replay = fetchMock.mock.calls[1]?.[1];
    expect(replay?.body).toBe(firstWrite?.body);
    expect((replay?.headers as Headers).get('Idempotency-Key')).toBe((firstWrite?.headers as Headers).get('Idempotency-Key'));
  });

  it('重新进入管理后恢复营地商品创建，回到营地商品库', async () => {
    const campProduct: Product = { ...product, name: '海边家具', type: 'island', asset_key: 'camp-chair' };
    const request = vi.fn(async (path: string) => {
      if (path === '/management/products') return campProduct;
      const group = new URL(path, 'http://fixture').searchParams.get('group');
      return { items: group === 'camp' ? [campProduct] : [] };
    });
    const client = { request: request as ApiClient['request'] };
    pendingProducts.set(client, {
      key: 'camp-replay',
      body: { asset_key: campProduct.asset_key, name: campProduct.name, coin_price: 0, diamond_price: 0, stock: null, enabled: true },
    });

    render(<ProductManagement client={client} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: content.recoverCreate }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: content.recoverCreate }));
    expect(await screen.findByRole('heading', { name: campProduct.name })).toBeVisible();
    expect(screen.getByRole('tab', { name: content.shopCamp })).toHaveAttribute('aria-selected', 'true');
  });

  it('编辑冲突保留草稿，重读后明确确认才提交新版本', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' }))
      .mockResolvedValueOnce({ items: [{ ...product, version: 2, name: '别处改名' }] })
      .mockResolvedValueOnce(product);
    render(<ProductEditor client={{ request }} session={session} product={product} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.name), { target: { value: '我的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    fireEvent.click(await screen.findByRole('button', { name: content.reloadProduct }));
    await screen.findByText(content.reviewProduct);
    expect(screen.getByLabelText(content.name)).toHaveValue('我的草稿');
    expect(request).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: content.confirmDraft }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[2]?.[1].body).toMatchObject({ expected_version: 2, name: '我的草稿' });
  });
});
