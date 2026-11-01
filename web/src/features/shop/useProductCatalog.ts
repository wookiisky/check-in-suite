import { useEffect, useRef, useState } from 'react';
import type { Product, ShopClient } from './types';
import { categoryPurchaseType, isWearableSlot, type CategoryFilter } from './shop-categories';

// 目录筛选在服务端作用于全部商品，而不是仅在当前页查找。
export interface CatalogSearch {
  search: string; // 名称或说明的搜索条件。
  provider: string; // 官方素材来源。
  packKey: string; // 素材包稳定身份。
}

// 筛选选项来自完整可见目录，不能由当前页推断。
export interface CatalogFacets {
  providers: string[]; // 目录中可用的来源。
  packs: { key: string; provider: string; name?: string }[]; // 来源对应的素材包及官方名称。
}

interface ProductPage {
  items: Product[]; // 本页报价，包含当前所有权事实。
  next_cursor?: string | null; // 没有游标时已到末页。
  facets?: CatalogFacets; // 完整目录的筛选选项。
}

interface CatalogOptions {
  filter: CategoryFilter; // 页面所选用途与部位。
  search: CatalogSearch; // 搜索与来源。
  revision: number; // 购买或管理成功后重新读取。
  includeInactive?: boolean; // 管理页查看下架商品。
}

// 首次读取与翻页共享代次；切换任何条件都会放弃旧页和迟到响应。
export function useProductCatalog(client: ShopClient, options: CatalogOptions) {
  const { filter, search, revision, includeInactive } = options;
  const query = new URLSearchParams({ limit: '48' });
  if (includeInactive) query.set('include_inactive', 'true');
  if (filter.group === 'appearance') {
    if (filter.category) query.set('type', categoryPurchaseType(filter.category));
    else query.set('group', 'appearance');
    if (isWearableSlot(filter.category)) query.set('slot', filter.category);
  } else if (filter.group !== 'all') query.set('type', filter.group);
  if (search.search) query.set('search', search.search);
  if (search.provider) query.set('provider', search.provider);
  if (search.packKey) query.set('pack_key', search.packKey);
  const path = `/products?${query}`;
  const generation = useRef(0); // 与取消配合，防止不遵守AbortSignal的传输覆盖新结果。
  const moreController = useRef<AbortController | null>(null); // 切换条件时也取消翻页。
  const loadingMoreRef = useRef(false); // 同一游标只允许一个在途读取。
  const [page, setPage] = useState<{ path: string; items: Product[]; cursor: string | null }>({ path: '', items: [], cursor: null });
  const [facets, setFacets] = useState<CatalogFacets>({ providers: [], packs: [] });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    const request = ++generation.current;
    setLoading(true); setLoadingMore(false); loadingMoreRef.current = false; setError(null);
    setPage({ path, items: [], cursor: null });
    void client.request<ProductPage>(path, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || generation.current !== request) return;
      setPage({ path, items: result.items, cursor: result.next_cursor ?? null });
      if (result.facets) setFacets(result.facets);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && generation.current === request) setError(reason);
    }).finally(() => {
      if (!controller.signal.aborted && generation.current === request) setLoading(false);
    });
    return () => { controller.abort(); moreController.current?.abort(); generation.current += 1; };
  }, [client, path, revision]);

  // 翻页失败保留已读报价和游标，重试仍读取同一页。
  async function more() {
    if (loading || loadingMoreRef.current || page.path !== path || !page.cursor) return;
    const request = generation.current;
    const controller = new AbortController(); moreController.current = controller;
    loadingMoreRef.current = true; setLoadingMore(true); setError(null);
    try {
      const result = await client.request<ProductPage>(`${path}&cursor=${encodeURIComponent(page.cursor)}`, { signal: controller.signal });
      if (controller.signal.aborted || generation.current !== request) return;
      setPage((current) => {
        const existing = new Set(current.items.map((item) => item.id));
        return { path, items: [...current.items, ...result.items.filter((item) => !existing.has(item.id))], cursor: result.next_cursor ?? null };
      });
    } catch (reason) {
      if (!controller.signal.aborted && generation.current === request) setError(reason);
    } finally {
      if (!controller.signal.aborted && generation.current === request) { loadingMoreRef.current = false; setLoadingMore(false); }
    }
  }
  return { products: page.path === path ? page.items : [], cursor: page.path === path ? page.cursor : null, facets, loading: loading || page.path !== path, loadingMore, error, more };
}
