import { useEffect, useRef, useState } from 'react';
import type { components } from '../../api/schema';
import type { Product, ShopClient } from './types';
import type { ShopGroup } from './shop-categories';

// 目录筛选在服务端作用于全部商品，而不是仅在当前页查找。
export interface CatalogSearch {
  search: string; // 名称或说明的搜索条件。
  provider: string; // 官方素材来源。
  packKey: string; // 素材包稳定身份。
}

// 筛选选项来自完整可见目录，不能由当前页推断。
export type CatalogFacets = components['schemas']['ProductFacets'];
type ProductPage = components['schemas']['ProductList'];
const emptyFacets: CatalogFacets = { providers: [], packs: [] };

interface CatalogOptions {
  search: CatalogSearch; // 搜索与来源。
  revision: number; // 购买或管理成功后重新读取。
  group: ShopGroup; // 商店分组。
  category: string; // 空值读取分组内全部商品。
}

// 首次读取与翻页共享代次；切换任何条件都会放弃旧页和迟到响应。
export function useProductCatalog(client: ShopClient, options: CatalogOptions) {
  const { search, revision, group, category } = options;
  const query = new URLSearchParams({ limit: '48', include_inactive: 'true', group });
  if (category) query.set('category', category);
  if (search.search) query.set('search', search.search);
  if (search.provider) query.set('provider', search.provider);
  if (search.packKey) query.set('pack_key', search.packKey);
  const path = `/products?${query}`;
  const generation = useRef(0); // 与取消配合，防止不遵守AbortSignal的传输覆盖新结果。
  const moreController = useRef<AbortController | null>(null); // 切换条件时也取消翻页。
  const loadingMoreRef = useRef(false); // 同一游标只允许一个在途读取。
  const [page, setPage] = useState<{ path: string; items: Product[]; cursor: string | null }>({ path: '', items: [], cursor: null });
  const [campCategories, setCampCategories] = useState<string[]>(['scene']);
  const [facetsByGroup, setFacetsByGroup] = useState<Partial<Record<ShopGroup, CatalogFacets>>>({});
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
      const facets = result.facets;
      if (facets) setFacetsByGroup((before) => ({ ...before, [group]: facets }));
      if (result.camp_categories) setCampCategories(result.camp_categories);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && generation.current === request) setError(reason);
    }).finally(() => {
      if (!controller.signal.aborted && generation.current === request) setLoading(false);
    });
    return () => { controller.abort(); moreController.current?.abort(); generation.current += 1; };
  }, [client, group, path, revision]);

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
  return { products: page.path === path ? page.items : [], cursor: page.path === path ? page.cursor : null, facets: facetsByGroup[group] ?? emptyFacets, campCategories, loading: loading || page.path !== path, loadingMore, error, more };
}
