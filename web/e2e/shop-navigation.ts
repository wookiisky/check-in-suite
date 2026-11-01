import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import spatial from '../src/features/island/three/spatial-content.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import appearance from '../src/features/shop/appearance-content.json' with { type: 'json' };

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

// 全屏营地先返回来源页面，再使用主导航回到首页。
export async function goHome(page: Page) {
  const island = page.getByRole('main', { name: spatial.title, exact: true });
  if (await island.isVisible()) await island.getByRole('button', { name: spatial.back, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.camp, exact: true }).click();
}

// 干净或已保存的外观可以关闭；未保存确认由具体流程明确处理。
export async function closeAppearance(page: Page) {
  const dialog = page.getByRole('dialog', { name: appearance.title, exact: true });
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: appearance.cancel, exact: true }).click();
}

// 首页和背包进入同一个三维外观编辑器。
export async function openAppearance(page: Page) {
  await closeAppearance(page);
  await goHome(page);
  await page.getByRole('button', { name: shop.wardrobeTitle, exact: true }).click();
  await expect(page.getByRole('dialog', { name: appearance.title, exact: true })).toBeVisible();
}

// 背包拥有独立页面，保留装扮和营地的明确入口。
export async function openBackpack(page: Page) {
  await closeAppearance(page);
  await goHome(page);
  await page.getByRole('button', { name: shop.backpack, exact: true }).click();
  await expect(page.getByRole('heading', { name: shop.backpack, exact: true })).toBeVisible();
}

// 两级分类由真实 Tab 操作，购买后应保持当前选择。
export async function selectShopCategory(page: Page, group: keyof typeof shop.categoryGroups, category?: string) {
  await closeAppearance(page);
  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await page.getByRole('tablist', { name: shop.categoryGroupLabel, exact: true }).getByRole('tab', { name: shop.categoryGroups[group], exact: true }).click();
  if (category) await page.getByRole('tablist', { name: shop.categoryDetailLabel, exact: true }).getByRole('tab', { name: category, exact: true }).click();
}

// 购买通过真实确认表单，金额和幂等性由服务端事务决定。
export async function purchaseProduct(page: Page, product: components['schemas']['Product']) {
  await page.getByRole('button', { name: `${shop.buy} ${product.name}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
