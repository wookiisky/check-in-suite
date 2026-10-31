import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import currency from '../src/components/content.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import island from '../src/features/island/content.json' with { type: 'json' };

type Camp = components['schemas']['CampResponse'];
type Wallet = Camp['wallet'];
type Product = components['schemas']['Product'];

// 数据准备走真实会话与服务端授权，界面写操作仍由页面提交。
async function api<T>(page: Page, path: string, method = 'GET', data?: unknown): Promise<T> {
  const session = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  const response = await page.request.fetch(`/api/v1${path}`, {
    method, data,
    headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.status() === 204 ? undefined as T : response.json() as Promise<T>;
}

// 独立币种容器保证金额不会被余额总字符串或其他页面价格混淆。
async function expectWallet(page: Page, wallet: Pick<Wallet, 'coins' | 'diamonds'>) {
  const global = page.locator('.global-wallet');
  await expect(global).toHaveCount(1);
  await expect(global).toBeVisible();
  for (const kind of ['coins', 'diamonds'] as const) {
    const amount = global.locator('.currency-amount').filter({ has: page.getByRole('img', { name: currency[kind], exact: true }) });
    await expect(amount).toHaveText(String(wallet[kind]));
  }
}

// 阻止后续页面读取先返回，证明余额由这次真实写回执立即更新。
async function expectReceiptWallet(page: Page, wallet: Pick<Wallet, 'coins' | 'diamonds'>, write: () => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending: Promise<void>[] = [];
  const handler = (route: Route) => {
    const request = gate.then(() => route.continue());
    pending.push(request);
    return request;
  };
  await page.route('**/api/v1/camp', handler);
  try {
    await write();
    await expectWallet(page, wallet);
  } finally {
    release();
    await Promise.all(pending);
    await page.unroute('**/api/v1/camp', handler);
  }
}

// 普通页共用同一余额，场景页沿用HUD；所有写入在等待刷新时已经更新金额。
test('全局余额在普通页面右上常驻，打卡购买删除即时同步且营地使用原HUD', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.global-wallet')).toHaveCount(0);
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await expect(page.getByRole('heading', { name: checkin.todayTasks, exact: true })).toBeVisible();
  const initial = await api<Camp>(page, '/camp');
  await expectWallet(page, initial.wallet);
  await expect(page.locator('.checkin-wallet, .shop-wallet')).toHaveCount(0);

  for (const route of ['calendar', 'stats', 'shop', 'achievements', 'camp'] as const) {
    await page.getByRole('button', { name: content.navigation[route], exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectWallet(page, initial.wallet);
  }
  await page.getByRole('button', { name: shop.backpack, exact: true }).click();
  await expect(page.getByRole('heading', { name: shop.backpack, exact: true })).toBeVisible();
  await expectWallet(page, initial.wallet);
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  for (const section of ['account', 'tasks', 'records', 'products', 'achievements'] as const) {
    const label = section === 'achievements' ? content.navigation.achievementManagement : content.navigation[section];
    await page.getByRole('navigation', { name: content.navigation.management, exact: true }).getByRole('button', { name: label, exact: true }).click();
    await expectWallet(page, initial.wallet);
  }
  const taskName = `全局余额打卡-${testInfo.project.name}`;
  await api(page, '/management/tasks', 'POST', {
    category_id: null, name: taskName, icon_key: 'book-v1', coin_reward: 7, diamond_reward: 3,
    daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true,
  });
  const product = await api<Product>(page, '/management/products', 'POST', {
    type: 'reward', name: `全局余额购买-${testInfo.project.name}`, asset_key: 'reward-gift-v1', description: '',
    coin_price: 2, diamond_price: 1, stock: null, enabled: true,
  });
  await page.getByRole('button', { name: content.navigation.camp, exact: true }).click();
  const task = page.locator('.checkin-task').filter({ hasText: taskName });
  await task.click();
  const granted = { coins: initial.wallet.coins + 7, diamonds: initial.wallet.diamonds + 3 };
  await expectReceiptWallet(page, granted, async () => {
    await page.getByRole('dialog').getByRole('button', { name: checkin.checkin, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await page.getByRole('button', { name: `${shop.buy} ${product.name}`, exact: true }).click();
  const purchased = { coins: granted.coins - 2, diamonds: granted.diamonds - 1 };
  await expectReceiptWallet(page, purchased, async () => {
    await page.getByRole('dialog').getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
  await page.getByRole('button', { name: content.navigation.camp, exact: true }).click();
  await page.locator('.checkin-record').filter({ hasText: taskName }).click();
  await page.getByRole('dialog').getByRole('button', { name: checkin.delete, exact: true }).click();
  const recovered = { coins: purchased.coins - 7, diamonds: purchased.diamonds - 3 };
  await expectReceiptWallet(page, recovered, async () => {
    await page.getByRole('dialog').getByRole('button', { name: checkin.confirmDelete, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
  const persisted = await api<Camp>(page, '/camp');
  expect(persisted.wallet).toMatchObject(recovered);
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  await expect(page.locator('.island-scene')).toBeVisible();
  await expect(page.locator('.global-wallet, .global-wallet-bar')).toHaveCount(0);
  await expect(page.locator('.island-wallet')).toHaveCount(1);
  await page.getByRole('button', { name: island.back, exact: true }).click();
  await expectWallet(page, recovered);

  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await expect(page.getByRole('article').first()).toBeVisible();
  await page.getByRole('article').last().scrollIntoViewIfNeeded();
  const position = await page.locator('.global-wallet').boundingBox();
  expect(position).not.toBeNull();
  expect(position!.y).toBeGreaterThanOrEqual(0);
  expect(position!.y).toBeLessThan(100);
  expect(position!.x + position!.width / 2).toBeGreaterThan(page.viewportSize()!.width / 2);
  await expect(page.locator('.global-wallet-bar')).toHaveCSS('position', 'sticky');
  await expect(page.locator('.global-wallet-bar')).toHaveCSS('top', '0px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.local/previews/global-wallet-${testInfo.project.name}.png` });
});
