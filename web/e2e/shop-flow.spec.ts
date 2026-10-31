import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import { openBackpack, openWardrobe, selectShopCategory } from './shop-navigation';
import type { components } from '../src/api/schema';

type Camp = components['schemas']['CampResponse'];
type Product = components['schemas']['Product'];
type Purchase = components['schemas']['Purchase'];

// 测试准备与持久结果校验使用浏览器真实会话，不跳过服务端权限。
async function api(page: Page, path: string, method = 'GET', data?: unknown) {
  const session = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  const response = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { Origin: 'http://127.0.0.1:15173', 'Sec-Fetch-Site': 'same-origin', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() } });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.status() === 204 ? null : response.json();
}

// 商品创建、未知购买、逐件装备与兑现均经过实际页面和持久服务。
test('真实商店购买恢复、十件装扮与逐次密码兑现', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  // 模拟通过服务器 HTTP IP 访问时缺少 randomUUID，保留浏览器真实随机源。
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  });
  const name = `小兔-${testInfo.project.name}`;
  await page.goto('/');
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
  const earningTask = await api(page, '/management/tasks', 'POST', { category_id: null, name: `购物准备-${testInfo.project.name}`, icon_key: 'book-v1', coin_reward: 10, diamond_reward: 10, daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true });
  await api(page, '/checkins', 'POST', { expected_today: (await api(page, '/camp') as Camp).today, task_id: earningTask.id, expected_task_version: earningTask.version, text: '', photo_media_id: null, audio_media_id: null });
  await page.getByRole('button', { name: content.navigation.products, exact: true }).click();
  await page.getByRole('button', { name: shop.addProduct, exact: true }).click();
  await page.getByRole('dialog').getByLabel(shop.name, { exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('combobox', { name: shop.typeFilter, exact: true }).selectOption('avatar');
  await page.getByRole('dialog').getByRole('combobox', { name: shop.asset, exact: true }).selectOption('bunny-v1');
  await page.getByRole('dialog').getByLabel(shop.coinPrice, { exact: true }).fill('3');
  await page.getByRole('dialog').getByLabel(shop.diamondPrice, { exact: true }).fill('2');
  await page.getByRole('dialog').getByRole('button', { name: shop.save, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const products = await api(page, '/products?include_inactive=true') as { items: Product[] };
  const avatar = products.items.find((item) => item.name === name)!;
  const before = await api(page, '/camp') as Camp;
  for (const accessory of before.equipment.accessories) await api(page, `/equipment/accessories/${accessory.id}`, 'DELETE');
  const accessories: Purchase[] = [];
  for (let index = 0; index < 11; index++) {
    const product = await api(page, '/management/products', 'POST', { type: 'accessory', name: `饰品-${testInfo.project.name}-${index}`, asset_key: 'accessory-star-v1', description: '', coin_price: 0, diamond_price: 0, stock: null, enabled: true }) as Product;
    const camp = await api(page, '/camp') as Camp;
    const result = await api(page, '/purchases', 'POST', { product_id: product.id, expected_product_version: product.version, expected_wallet_version: camp.wallet.version });
    accessories.push(result.purchase as Purchase);
  }
  const reward = await api(page, '/management/products', 'POST', { type: 'reward', name: `奖励-${testInfo.project.name}`, asset_key: 'reward-gift-v1', description: '', coin_price: 0, diamond_price: 0, stock: null, enabled: true }) as Product;
  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();

  const avatarCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(avatarCard.getByRole('img', { name: shop.coins, exact: true })).toBeVisible();
  await expect(avatarCard.getByRole('img', { name: shop.diamonds, exact: true })).toBeVisible();
  await expect(avatarCard.getByRole('img', { name: shop.ownedCount, exact: true }).locator('..')).toHaveText('0');
  const rewardCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: reward.name, exact: true }) });
  await expect(rewardCard.getByRole('img', { name: shop.diamonds, exact: true })).toHaveCount(0);
  const artwork = avatarCard.locator('.shop-item-art');
  await expect(artwork).toBeVisible();
  const artBounds = (await artwork.boundingBox())!;
  const heading = avatarCard.getByRole('heading', { name, exact: true });
  const headingBounds = (await heading.boundingBox())!;
  expect(headingBounds.y + headingBounds.height).toBeLessThanOrEqual(artBounds.y);
  await expect(heading).toHaveCSS('text-align', 'center');
  expect(await heading.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(28);
  const priceButton = avatarCard.getByRole('button', { name: `${shop.buy} ${name}`, exact: true });
  await expect(priceButton.getByRole('img', { name: shop.coins, exact: true })).toBeVisible();
  await expect(priceButton.getByRole('img', { name: shop.diamonds, exact: true })).toBeVisible();
  await expect(priceButton).not.toContainText(shop.buy);
  expect(await priceButton.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(24);
  const owned = avatarCard.getByRole('img', { name: shop.ownedCount, exact: true }).locator('..');
  const ownedBounds = (await owned.boundingBox())!;
  const buttonBounds = (await priceButton.boundingBox())!;
  expect(ownedBounds.x).toBeGreaterThan(buttonBounds.x + buttonBounds.width);
  expect(Math.abs(ownedBounds.y + ownedBounds.height / 2 - buttonBounds.y - buttonBounds.height / 2)).toBeLessThan(2);
  expect(artBounds.width).toBeGreaterThanOrEqual(160);
  expect(artBounds.height).toBeGreaterThanOrEqual(160);
  expect(await artwork.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await avatarCard.screenshot({ path: `.local/previews/shop-card-${testInfo.project.name}.png` });

  await page.getByRole('tablist', { name: shop.categoryGroupLabel, exact: true }).getByRole('tab', { name: shop.categoryGroups.appearance, exact: true }).click();
  await page.getByRole('tablist', { name: shop.categoryDetailLabel, exact: true }).getByRole('tab', { name: shop.types.avatar, exact: true }).click();

  let dropped = false;
  const keys: string[] = [];
  await page.route('**/api/v1/purchases', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (!dropped) { dropped = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByRole('button', { name: `${shop.buy} ${name}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
  await expect(page.getByRole('dialog').getByText(shop.purchasePending)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: shop.close, exact: true }).first().click();
  await page.getByRole('button', { name: shop.recoverPurchase, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: shop.recoverPurchase, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: shop.categoryGroups.appearance, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: shop.types.avatar, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(avatarCard.getByRole('button', { name: `${shop.buy} ${name}`, exact: true })).toBeDisabled();
  await expect(avatarCard.getByRole('img', { name: shop.ownedCount, exact: true }).locator('..')).toHaveText('1');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(keys[0]).toBe(keys[1]);
  await page.unroute('**/api/v1/purchases');
  const purchasedCamp = await api(page, '/camp') as Camp;
  expect(purchasedCamp.equipment.avatar?.product_id).not.toBe(avatar.id);
  expect(purchasedCamp.wallet.coins).toBe(before.wallet.coins - 3);
  expect(purchasedCamp.wallet.diamonds).toBe(before.wallet.diamonds - 2);
  const purchases = await api(page, '/purchases?status=owned') as { items: Purchase[] };
  expect(purchases.items.filter((item) => item.product_id === avatar.id)).toHaveLength(1);
  await openWardrobe(page);
  await page.getByRole('button', { name: `${shop.equip} ${name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${shop.unequip} ${name}`, exact: true })).toBeEnabled();
  for (const item of accessories.slice(0, 10)) {
    await page.getByRole('button', { name: `${shop.equip} ${item.name_snapshot}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `${shop.unequip} ${item.name_snapshot}`, exact: true })).toBeEnabled();
  }
  await expect(page.getByRole('button', { name: `${shop.equip} ${accessories[10]!.name_snapshot}`, exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog', { name: shop.wardrobeTitle, exact: true }).locator('.shop-character .shop-accessory-art')).toHaveCount(10);
  const equipment = (await api(page, '/camp') as Camp).equipment;
  expect(equipment.accessories).toHaveLength(10);
  expect(equipment.avatar?.product_id).toBe(avatar.id);
  const art = await page.getByRole('dialog', { name: shop.wardrobeTitle, exact: true }).locator('.shop-character img').evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0));
  expect(art).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await page.getByRole('dialog', { name: shop.wardrobeTitle, exact: true }).locator('.shop-character').screenshot({ path: `.local/previews/wardrobe-${testInfo.project.name}.png` });

  // 每次兑现打开空密码表单；购买及兑现都不自动获得管理授权。
  for (let index = 0; index < 2; index++) {
    await selectShopCategory(page, 'reward');
    await page.getByRole('button', { name: `${shop.buy} ${reward.name}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: shop.categoryGroups.reward, exact: true })).toHaveAttribute('aria-selected', 'true');
    await openBackpack(page);
    await page.getByRole('tablist', { name: shop.categoryGroupLabel, exact: true }).getByRole('tab', { name: shop.categoryGroups.reward, exact: true }).click();
    await page.getByRole('button', { name: `${shop.redeem} ${reward.name}`, exact: true }).click();
    await expect(page.getByLabel(shop.redeemPassword)).toHaveValue('');
    await page.getByLabel(shop.redeemPassword).fill('Manage-Test-2026');
    await page.getByRole('dialog').getByRole('button', { name: shop.confirmRedeem, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  const redeemed = await api(page, '/purchases?type=reward&status=redeemed') as { items: Purchase[] };
  expect(redeemed.items.filter((item) => item.product_id === reward.id)).toHaveLength(2);
  expect((await api(page, '/session')).management_expires_at).toBeNull();
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.products, exact: true }).click();
  await page.getByRole('button', { name: `${shop.delete} ${name}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: shop.confirmDelete, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  expect((await api(page, '/camp') as Camp).equipment).toEqual(equipment);
});
