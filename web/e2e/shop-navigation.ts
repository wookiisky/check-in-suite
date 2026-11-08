import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { components } from '../src/api/schema';
import pagination from '../src/components/numbered-pagination-content.json' with { type: 'json' };
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };

// 主入口使用正式登录表单，不以注入 Cookie 代替会话授权。
export async function loginMain(page: Page) {
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await expect(page.getByRole('heading', { name: checkin.todayTasks, exact: true })).toBeVisible();
}

// 所有准备、清理与持久化断言均使用当前真实会话和服务端 CSRF。
export async function shopAPI<T = unknown>(page: Page, path: string, method = 'GET', data?: unknown): Promise<T> {
  const sessionResponse = await page.request.get('/api/v1/session');
  expect(sessionResponse.ok()).toBe(true);
  const session = await sessionResponse.json() as components['schemas']['SessionResponse'];
  const response = await page.request.fetch(`/api/v1${path}`, { method, ...(data === undefined ? {} : { data }), headers: { Origin: 'http://127.0.0.1:15173', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() } });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.status() === 204 ? undefined as T : response.json() as Promise<T>;
}

// 各主页面共用标题栏入口。
export async function goHome(page: Page) {
  await page.getByRole('navigation', { name: content.navigation.label }).getByRole('button', { name: content.navigation.camp, exact: true }).click();
}

// 干净或已保存的装扮页通过主导航离开。
export async function closeAppearance(page: Page) {
  if (await page.locator('.appearance-page').isVisible()) await goHome(page);
}

// 从主导航直接进入独立装扮页。
export async function openAppearance(page: Page) {
  await page.getByRole('navigation', { name: content.navigation.label }).getByRole('button', { name: content.navigation.appearance, exact: true }).click();
  await expect(page.locator('.appearance-page')).toBeVisible();
}

// 两级分类由真实 Tab 操作，购买后应保持当前选择。
export async function selectShopCategory(page: Page, group: 'appearance' | 'island' | 'scene', category?: string) {
  const wardrobe = group === 'appearance';
  await page.getByRole('navigation', { name: content.navigation.label }).getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await page.getByRole('tablist', { name: shop.categoryGroupLabel, exact: true }).getByRole('tab', { name: wardrobe ? shop.categoryGroups.appearance : shop.shopCamp, exact: true }).click();
  const detail = group === 'scene' ? shop.campCategories.scene : category ?? shop.categoryGroups.all;
  await page.getByRole('tablist', { name: wardrobe ? shop.categoryDetailLabel : shop.campCategoryLabel, exact: true }).getByRole('tab', { name: detail, exact: true }).click();
}

// 从素材库选取一个有固定类型的营地场景，进入新增商品表单。
export async function openSceneProductEditor(page: Page, assetName: string) {
  await page.getByRole('button', { name: shop.addProduct, exact: true }).click();
  const materials = page.getByRole('tab', { name: shop.materialLibrary, exact: true });
  await expect(materials).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tablist', { name: shop.materialGroupLabel, exact: true }).getByRole('tab', { name: shop.shopCamp, exact: true }).click();
  await page.getByRole('tablist', { name: shop.campCategoryLabel, exact: true }).getByRole('tab', { name: shop.campCategories.scene, exact: true }).click();
  await page.getByRole('button', { name: `${shop.addProduct} ${assetName}`, exact: true }).click();
}

// 通过真实分页定位同一分类中可能位于后页的报价。
export async function shopProductButton(page: Page, product: components['schemas']['Product']) {
  const button = page.getByRole('button', { name: `${shop.buy} ${product.name}`, exact: true });
  const loading = page.getByText(shop.loading, { exact: true });
  const next = page.getByRole('button', { name: pagination.next, exact: true });
  await expect(loading).toHaveCount(0);
  while (!(await button.isVisible()) && await next.isVisible() && await next.isEnabled()) {
    await next.click();
    await expect(loading).toHaveCount(0);
  }
  await expect(button).toBeVisible();
  return button;
}

// 购买通过真实确认表单，金额和幂等性由服务端事务决定。
export async function purchaseProduct(page: Page, product: components['schemas']['Product']) {
  await (await shopProductButton(page, product)).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
