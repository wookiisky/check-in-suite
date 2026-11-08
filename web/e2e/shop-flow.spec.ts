import { expect, test } from '@playwright/test';
import type { components } from '../src/api/schema';
import shop from '../src/features/shop/content.json' with { type: 'json' };
import { loginMain, selectShopCategory, shopAPI, shopProductButton } from './shop-navigation';

type Camp = components['schemas']['CampResponse'];
type Product = components['schemas']['Product'];
type Task = components['schemas']['Task'];
type Checkin = components['schemas']['Checkin'];

// 服务端已成交而客户端未收到回执时，重试同一幂等键，保持分类和购买位置。
test('商店断响应恢复只扣一次双币，成交卡片留在当页置灰', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }); });
  await loginMain(page);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  let task: Task | null = null;
  let earned: Checkin | null = null;
  let offer: Product | null = null;
  const name = `购买恢复家具-${testInfo.project.name}`;
  try {
    await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
    const initial = await shopAPI<Camp>(page, '/camp');
    task = await shopAPI<Task>(page, '/management/tasks', 'POST', {
      category_id: null, name: `购物准备-${testInfo.project.name}`, icon_key: 'book-v1',
      coin_reward: Math.max(10, 10 - initial.wallet.coins), diamond_reward: Math.max(10, 10 - initial.wallet.diamonds),
      daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true,
    });
    earned = (await shopAPI<components['schemas']['CheckinResult']>(page, '/checkins', 'POST', {
      expected_today: initial.today, task_id: task.id, expected_task_version: task.version, text: '', photo_media_id: null, audio_media_id: null,
    })).checkin;
    const furniture = (await shopAPI<components['schemas']['ShopPage']>(page, '/shop/products?group=camp&category=furniture&limit=100')).items.find((item) => item.repeatable);
    expect(furniture).toBeDefined();
    offer = await shopAPI<Product>(page, '/management/products', 'POST', {
      type: 'island', name, asset_key: furniture!.asset_key, description: '', coin_price: 3, diamond_price: 2, stock: null, enabled: true,
    });
    await shopAPI(page, '/management/lock', 'POST');
    await selectShopCategory(page, 'island', shop.campCategories.furniture);
    const before = await shopAPI<Camp>(page, '/camp');
    const priceButton = await shopProductButton(page, offer);
    const card = page.getByRole('article').filter({ has: priceButton });
    const artwork = card.locator('.shop-item-art');
    const heading = card.getByRole('heading', { name, exact: true });
    await artwork.scrollIntoViewIfNeeded();
    await expect.poll(() => artwork.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const artBounds = (await artwork.boundingBox())!;
    const headingBounds = (await heading.boundingBox())!;
    expect(headingBounds.y + headingBounds.height).toBeLessThanOrEqual(artBounds.y);
    await expect(heading).toHaveCSS('text-align', 'center');
    expect(await heading.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(28);
    expect(await priceButton.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(24);
    expect(artBounds.width).toBeGreaterThanOrEqual(160);
    expect(artBounds.height).toBeGreaterThanOrEqual(160);
    await expect(priceButton.getByRole('img', { name: shop.coins, exact: true })).toBeVisible();
    await expect(priceButton.getByRole('img', { name: shop.diamonds, exact: true })).toBeVisible();

    const keys: string[] = [];
    let dropped = false;
    await page.route('**/api/v1/purchases', async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      if (!dropped) {
        dropped = true;
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    await priceButton.click();
    await page.getByRole('dialog').getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
    await expect(page.getByRole('dialog').getByText(shop.purchasePending)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: shop.close, exact: true }).first().click();
    await page.getByRole('button', { name: shop.recoverPurchase, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: shop.recoverPurchase, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.unroute('**/api/v1/purchases');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(keys[0]).toBe(keys[1]);
    await expect(page.getByRole('tab', { name: shop.campCategories.furniture, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(priceButton).toBeDisabled();
    await expect(card.getByText(shop.owned, { exact: true })).toBeVisible();

    const purchased = await shopAPI<Camp>(page, '/camp');
    expect(purchased.wallet.coins).toBe(before.wallet.coins - 3);
    expect(purchased.wallet.diamonds).toBe(before.wallet.diamonds - 2);
    expect(purchased.equipment).toEqual(before.equipment);
    const owned = await shopAPI<components['schemas']['PurchaseList']>(page, '/purchases?status=owned&type=island');
    expect(owned.items.filter((item) => item.product_id === offer?.id)).toHaveLength(1);
    const browse = await shopAPI<components['schemas']['ShopPage']>(page, '/shop/products?group=camp&category=furniture&limit=100');
    expect(browse.items.some((item) => item.island_item_key === offer?.island_item_key)).toBe(false);
  } finally {
    await page.unroute('**/api/v1/purchases');
    await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
    if (offer) await shopAPI(page, `/management/products/${offer.id}`, 'DELETE', { expected_version: offer.version });
    if (earned) await shopAPI(page, `/checkins/${earned.id}`, 'DELETE', { expected_version: earned.version });
    if (task) await shopAPI(page, `/management/tasks/${task.id}`, 'DELETE', { expected_version: task.version });
    await shopAPI(page, '/management/lock', 'POST');
  }
});
