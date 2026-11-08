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
  await page.getByRole('tablist', { name: shop.categoryGroupLabel, exact: true }).getByRole('tab', { name: shop.shopCamp, exact: true }).click();
  await page.getByRole('button', { name: shop.addProduct, exact: true }).click();
  const materials = page.getByRole('tab', { name: shop.materialLibrary, exact: true });
  await expect(materials).toHaveAttribute('aria-selected', 'true');
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

type Camp = components['schemas']['CampResponse'];
type Product = components['schemas']['Product'];
type Task = components['schemas']['Task'];
type Funding = { task: Task; record: components['schemas']['Checkin'] };

// 余额来自真实打卡奖励，购买仍由页面提交完整价格和版本。
export async function fundPurchase(page: Page, product: Product, name: string): Promise<Funding> {
  await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
  const camp = await shopAPI<Camp>(page, '/camp');
  const task = await shopAPI<Task>(page, '/management/tasks', 'POST', { category_id: null, name, icon_key: 'book-v1', coin_reward: Math.max(1, product.coin_price - camp.wallet.coins), diamond_reward: Math.max(1, product.diamond_price - camp.wallet.diamonds), daily_limit: 2, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true });
  const result = await shopAPI<components['schemas']['CheckinResult']>(page, '/checkins', 'POST', { expected_today: camp.today, task_id: task.id, expected_task_version: task.version, text: '', photo_media_id: null, audio_media_id: null });
  await shopAPI(page, '/management/lock', 'POST');
  return { task, record: result.checkin };
}

// 还原任务与资格，不直接修改账本或伪造购买撤销。
export async function clearFunding(page: Page, funding: Funding | null) {
  if (!funding) return;
  await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
  await shopAPI(page, `/checkins/${funding.record.id}`, 'DELETE', { expected_version: funding.record.version });
  await shopAPI(page, `/management/tasks/${funding.task.id}`, 'DELETE', { expected_version: funding.task.version });
  await shopAPI(page, '/management/lock', 'POST');
}
