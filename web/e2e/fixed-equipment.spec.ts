import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import { closeWardrobe, openWardrobe, selectShopCategory } from './shop-navigation';

type Camp = components['schemas']['CampResponse'];
type Product = components['schemas']['Product'];
type Equipment = components['schemas']['Equipment'];

// 准备商品及核对持久结果均使用浏览器真实会话和服务端权限。
async function api(page: Page, path: string, method = 'GET', data?: unknown) {
  const result = await page.evaluate(async ({ path, method, data, key }) => {
    const session = await (await fetch('/api/v1/session')).json();
    const response = await fetch(`/api/v1${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': key },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }, { path, method, data, key: crypto.randomUUID() });
  expect(result.ok, `${method} ${path}: ${result.text}`).toBeTruthy();
  return result.status === 204 ? null : JSON.parse(result.text);
}

// 普通用户免费换人、购买穿戴、刷新恢复，并在小岛看到同一套图层。
test('人类基础形象、独立发型和服装在衣柜主页与小岛一致', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
  const task = await api(page, '/management/tasks', 'POST', { category_id: null, name: `换装准备-${testInfo.project.name}`, icon_key: 'book-v1', coin_reward: 1, diamond_reward: 1, daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true });
  await api(page, '/checkins', 'POST', { expected_today: (await api(page, '/camp') as Camp).today, task_id: task.id, expected_task_version: task.version, text: '', photo_media_id: null, audio_media_id: null });
  const products: { slot: keyof Equipment['wearables']; product: Product }[] = [];
  for (const [slot, assetKey] of [
    ['hair', 'hair-braids-v1'], ['top', 'wearable-top-explorer-v1'], ['bottom', 'wearable-bottom-denim-v1'], ['shoes', 'wearable-shoes-boots-v1'],
  ] as const) {
    const product = await api(page, '/management/products', 'POST', { type: 'accessory', name: `${shop.wearableSlots[slot]}-${testInfo.project.name}`, asset_key: assetKey, description: '', coin_price: 0, diamond_price: 0, stock: null, enabled: true }) as Product;
    products.push({ slot, product });
  }
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await openWardrobe(page);
  await page.getByRole('button', { name: shop.baseAvatarNames['avatar-girl-v2'], exact: true }).click();
  await expect(page.getByRole('button', { name: shop.baseAvatarNames['avatar-girl-v2'], exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await api(page, '/session')).management_expires_at).toBeNull();

  for (const { slot, product } of products) {
    await selectShopCategory(page, 'appearance', shop.wearableSlots[slot]);
    await page.getByRole('button', { name: `${shop.buy} ${product.name}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: shop.wearableSlots[slot], exact: true })).toHaveAttribute('aria-selected', 'true');
    await openWardrobe(page);
    await page.getByRole('button', { name: `${shop.equip} ${product.name}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `${shop.unequip} ${product.name}`, exact: true })).toBeEnabled();
  }
  const equipped = (await api(page, '/camp') as Camp).equipment;
  for (const { slot, product } of products) expect(equipped.wearables[slot]?.product_id).toBe(product.id);
  const wardrobe = page.getByRole('dialog', { name: shop.wardrobeTitle, exact: true }).locator('.shop-character [data-base-avatar]');
  const layerAssets = await wardrobe.locator('image').evaluateAll((images) => images.map((image) => image.getAttribute('href')));
  expect(layerAssets).toContain('/api/v1/assets/hair-braids-back-v1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await page.getByRole('dialog', { name: shop.wardrobeTitle, exact: true }).locator('.shop-character').screenshot({ path: `spec/assets/character-wardrobe-${testInfo.project.name === 'iphone14-webkit' ? 'mobile' : 'desktop'}.png` });

  await page.reload();
  await openWardrobe(page);
  await expect(wardrobe).toHaveAttribute('data-base-avatar', 'avatar-girl-v2');
  expect((await api(page, '/camp') as Camp).equipment).toEqual(equipped);
  await page.getByRole('button', { name: shop.baseAvatarNames['avatar-boy-v2'], exact: true }).click();
  await expect(wardrobe).toHaveAttribute('data-base-avatar', 'avatar-boy-v2');
  expect((await api(page, '/camp') as Camp).equipment.wearables).toEqual(equipped.wearables);
  const boyAssets = await wardrobe.locator('image').evaluateAll((images) => images.map((image) => image.getAttribute('href')));

  await closeWardrobe(page);
  await page.getByRole('button', { name: content.navigation.camp, exact: true }).click();
  await expect(page.locator('.shop-character [data-base-avatar]')).toHaveAttribute('data-base-avatar', 'avatar-boy-v2');
  expect(await page.locator('.shop-character [data-base-avatar] image').evaluateAll((images) => images.map((image) => image.getAttribute('href')))).toEqual(boyAssets);
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  const islandCharacter = page.locator('.island-character-art [data-base-avatar]');
  await expect(islandCharacter).toHaveAttribute('data-base-avatar', 'avatar-boy-v2');
  expect(await islandCharacter.locator('image').evaluateAll((images) => images.map((image) => image.getAttribute('href')))).toEqual(boyAssets);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await page.locator('.island-scene').screenshot({ path: `spec/assets/character-island-${testInfo.project.name === 'iphone14-webkit' ? 'mobile' : 'desktop'}.png` });

  await openWardrobe(page);
  const hair = products.find((item) => item.slot === 'hair')!.product;
  await page.getByRole('button', { name: `${shop.unequip} ${hair.name}`, exact: true }).click();
  await expect(wardrobe.locator('[data-character-layer="hair"]')).toHaveAttribute('href', '/api/v1/assets/default-boy-hair-v1');
  expect((await api(page, '/camp') as Camp).equipment.wearables.hair).toBeNull();
});
