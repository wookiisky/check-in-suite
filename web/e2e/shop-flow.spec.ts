import { expect, test } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import { loginMain, openBackpack, selectShopCategory, shopAPI, purchaseProduct } from './shop-navigation';

type Camp = components['schemas']['CampResponse'];
type Product = components['schemas']['Product'];
type Task = components['schemas']['Task'];
type Checkin = components['schemas']['Checkin'];
type Purchase = components['schemas']['Purchase'];

// 真实双币扣款、幂等恢复和逐次密码兑现与三维渲染独立，不能随二维入口退休。
test('商店真实断响应购买恢复只扣一次双币并逐次密码兑现奖励', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }); });
  await loginMain(page);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  let task: Task | null = null;
  let earned: Checkin | null = null;
  const created: Product[] = [];
  try {
    await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
    await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
    await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
    await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
    const initial = await shopAPI<Camp>(page, '/camp');
    task = await shopAPI<Task>(page, '/management/tasks', 'POST', { category_id: null, name: `购物准备-${testInfo.project.name}`, icon_key: 'book-v1', coin_reward: Math.max(10, 10 - initial.wallet.coins), diamond_reward: Math.max(10, 10 - initial.wallet.diamonds), daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true });
    earned = (await shopAPI<components['schemas']['CheckinResult']>(page, '/checkins', 'POST', { expected_today: initial.today, task_id: task.id, expected_task_version: task.version, text: '', photo_media_id: null, audio_media_id: null })).checkin;
    const assets = await shopAPI<components['schemas']['AssetList']>(page, '/assets');
    const titleAsset = assets.items.find((asset) => asset.kind === 'title')!;
    const name = `购买恢复称号-${testInfo.project.name}`;
    await page.getByRole('button', { name: content.navigation.products, exact: true }).click();
    await page.getByRole('button', { name: shop.addProduct, exact: true }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel(shop.name, { exact: true }).fill(name);
    await editor.getByRole('combobox', { name: shop.typeFilter, exact: true }).selectOption('title');
    await editor.getByRole('combobox', { name: shop.asset, exact: true }).selectOption(titleAsset.key);
    await editor.getByLabel(shop.coinPrice, { exact: true }).fill('3');
    await editor.getByLabel(shop.diamondPrice, { exact: true }).fill('2');
    const creation = page.waitForResponse((response) => response.url().endsWith('/api/v1/management/products') && response.request().method() === 'POST');
    await editor.getByRole('button', { name: shop.save, exact: true }).click();
    const title = await (await creation).json() as Product;
    created.push(title);
    await expect(editor).toHaveCount(0);
    const reward = await shopAPI<Product>(page, '/management/products', 'POST', { type: 'reward', name: `逐次兑现-${testInfo.project.name}`, asset_key: assets.items.find((asset) => asset.kind === 'reward')!.key, description: '', coin_price: 0, diamond_price: 0, stock: null, enabled: true });
    created.push(reward);
    await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
    await selectShopCategory(page, 'appearance', shop.types.title);
    const before = await shopAPI<Camp>(page, '/camp');
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card.getByRole('img', { name: shop.ownedCount, exact: true }).locator('..')).toHaveText('0');
    const artwork = card.locator('.shop-item-art');
    const heading = card.getByRole('heading', { name, exact: true });
    const priceButton = card.getByRole('button', { name: `${shop.buy} ${name}`, exact: true });
    const ownedCount = card.getByRole('img', { name: shop.ownedCount, exact: true }).locator('..');
    const artBounds = (await artwork.boundingBox())!;
    const headingBounds = (await heading.boundingBox())!;
    const ownedBounds = (await ownedCount.boundingBox())!;
    const buttonBounds = (await priceButton.boundingBox())!;
    expect(headingBounds.y + headingBounds.height).toBeLessThanOrEqual(artBounds.y);
    await expect(heading).toHaveCSS('text-align', 'center');
    expect(await heading.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(28);
    expect(await priceButton.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(24);
    expect(artBounds.width).toBeGreaterThanOrEqual(160);
    expect(artBounds.height).toBeGreaterThanOrEqual(160);
    expect(ownedBounds.x).toBeGreaterThan(buttonBounds.x + buttonBounds.width);
    expect(Math.abs(ownedBounds.y + ownedBounds.height / 2 - buttonBounds.y - buttonBounds.height / 2)).toBeLessThan(2);
    expect(await artwork.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);

    await expect(card.getByRole('button', { name: `${shop.buy} ${name}`, exact: true }).getByRole('img', { name: shop.coins, exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: `${shop.buy} ${name}`, exact: true }).getByRole('img', { name: shop.diamonds, exact: true })).toBeVisible();
    const keys: string[] = [];
    let dropped = false;
    await page.route('**/api/v1/purchases', async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      if (!dropped) { dropped = true; expect((await route.fetch()).ok()).toBe(true); await route.abort('failed'); }
      else await route.continue();
    });
    await page.getByRole('button', { name: `${shop.buy} ${name}`, exact: true }).click();
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
    await expect(page.getByRole('tab', { name: shop.types.title, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(card.getByRole('img', { name: shop.ownedCount, exact: true }).locator('..')).toHaveText('1');
    const purchased = await shopAPI<Camp>(page, '/camp');
    expect(purchased.wallet.coins).toBe(before.wallet.coins - 3);
    expect(purchased.wallet.diamonds).toBe(before.wallet.diamonds - 2);
    expect(purchased.equipment.title).toEqual(before.equipment.title);
    const owned = await shopAPI<components['schemas']['PurchaseList']>(page, '/purchases?status=owned&type=title');
    expect(owned.items.filter((item) => item.product_id === title.id)).toHaveLength(1);
    for (let index = 0; index < 2; index++) {
      await selectShopCategory(page, 'reward');
      await purchaseProduct(page, reward);
      await openBackpack(page);
      await page.getByRole('tablist', { name: shop.categoryGroupLabel, exact: true }).getByRole('tab', { name: shop.categoryGroups.reward, exact: true }).click();
      await page.getByRole('button', { name: `${shop.redeem} ${reward.name}`, exact: true }).click();
      await expect(page.getByLabel(shop.redeemPassword)).toHaveValue('');
      await page.getByLabel(shop.redeemPassword).fill('Manage-Test-2026');
      await page.getByRole('dialog').getByRole('button', { name: shop.confirmRedeem, exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    const redeemed = await shopAPI<{ items: Purchase[] }>(page, '/purchases?type=reward&status=redeemed');
    expect(redeemed.items.filter((item) => item.product_id === reward.id)).toHaveLength(2);
    expect((await shopAPI<components['schemas']['SessionResponse']>(page, '/session')).management_expires_at).toBeNull();
    await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
    await shopAPI(page, `/management/products/${title.id}`, 'DELETE', { expected_version: title.version });
    created.splice(created.indexOf(title), 1);
    expect((await shopAPI<components['schemas']['PurchaseList']>(page, '/purchases?status=owned&type=title')).items.some((item) => item.product_id === title.id)).toBe(true);
  } finally {
    await page.unroute('**/api/v1/purchases');
    await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
    for (const product of created) await shopAPI(page, `/management/products/${product.id}`, 'DELETE', { expected_version: product.version });
    if (earned) await shopAPI(page, `/checkins/${earned.id}`, 'DELETE', { expected_version: earned.version });
    if (task) await shopAPI(page, `/management/tasks/${task.id}`, 'DELETE', { expected_version: task.version });
    await shopAPI(page, '/management/lock', 'POST');
  }
});
