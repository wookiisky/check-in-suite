import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import family from '../src/features/family/content.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import { closeConfigurationSettings, openConfigurationSettings } from './configuration-navigation';

type Camp = components['schemas']['CampResponse'];
type Product = components['schemas']['Product'];
type Purchase = components['schemas']['Purchase'];
type Session = components['schemas']['SessionResponse'];

// 准备数据和检查持久结果都使用实际登录会话、CSRF 与服务端接口。
async function api<T>(page: Page, path: string, method = 'GET', data?: unknown): Promise<T> {
  const session = await (await page.request.get('/api/v1/session')).json() as Session;
  const response = await page.request.fetch(`/api/v1${path}`, {
    method,
    data,
    headers: {
      Origin: 'http://127.0.0.1:15173',
      'X-CSRF-Token': session.csrf_token,
      'Idempotency-Key': crypto.randomUUID(),
    },
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.status() === 204 ? undefined as T : response.json() as Promise<T>;
}

// 每个浏览器项目创建自己的永久商品，避免依赖其他流程留下的订单。
async function buyFixture(page: Page, input: Pick<Product, 'type' | 'name' | 'asset_key'>) {
  const product = await api<Product>(page, '/management/products', 'POST', {
    ...input, description: '', coin_price: 0, diamond_price: 0, stock: null, enabled: true,
  });
  const camp = await api<Camp>(page, '/camp');
  const result = await api<{ purchase: Purchase }>(page, '/purchases', 'POST', {
    product_id: product.id,
    expected_product_version: product.version,
    expected_wallet_version: camp.wallet.version,
  });
  return result.purchase;
}

// 等待真实保存响应，避免把正在保存时的禁用按钮误判为保存完成。
async function saveLayout(page: Page, purchaseID: string) {
  const response = page.waitForResponse((item) =>
    item.url().endsWith(`/equipment/accessories/${purchaseID}/layout`) && item.request().method() === 'PATCH');
  await page.getByRole('dialog').getByRole('button', { name: shop.save, exact: true }).click();
  expect((await response).ok()).toBeTruthy();
  await expect(page.getByRole('dialog').getByRole('button', { name: shop.save, exact: true })).toBeDisabled();
}

// 操作框须始终覆盖素材，悬停、按下或减少动效都不能改变中心和尺寸。
async function expectAccessoryAligned(handle: Locator, artwork: Locator) {
  await expect.poll(async () => {
    const control = await handle.boundingBox();
    const image = await artwork.boundingBox();
    if (!control || !image) return Infinity;
    return Math.max(Math.abs(control.x - image.x), Math.abs(control.y - image.y), Math.abs(control.width - image.width), Math.abs(control.height - image.height));
  }).toBeLessThan(1);
}

// 桌面用实际指针拖动，手机模拟器用微调按钮；两者共用真实保存和重载断言。
test('背景、可编辑饰品和固定特效在保存刷新后保持组合', async ({ page, isMobile }, testInfo) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();

  const existing = (await api<Camp>(page, '/camp')).equipment;
  for (const item of existing.accessories) await api(page, `/equipment/accessories/${item.id}`, 'DELETE');
  for (const item of existing.effects) await api(page, `/equipment/effects/${item.id}`, 'DELETE');
  await api(page, '/equipment/background', 'PUT', { purchase_id: null });
  await api(page, '/equipment/avatar', 'PUT', { purchase_id: null });
  await api(page, '/account/preferences', 'PATCH', { reduce_motion: false });

  const suffix = testInfo.project.name;
  const beforeBuying = await api<Camp>(page, '/camp');
  const earning = await api<{ id: string; version: number }>(page, '/management/tasks', 'POST', {
    category_id: null, name: `装扮准备-${suffix}`, icon_key: 'book-v1',
    coin_reward: Math.max(1, -beforeBuying.wallet.coins), diamond_reward: Math.max(1, -beforeBuying.wallet.diamonds),
    daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true,
  });
  await api(page, '/checkins', 'POST', {
    expected_today: beforeBuying.today, task_id: earning.id, expected_task_version: earning.version,
    text: '', photo_media_id: null, audio_media_id: null,
  });
  const background = await buyFixture(page, { type: 'background', name: `草地-${suffix}`, asset_key: 'background-meadow-v1' });
  const star = await buyFixture(page, { type: 'accessory', name: `星星-${suffix}`, asset_key: 'accessory-star-v1' });
  const hat = await buyFixture(page, { type: 'accessory', name: `帽子-${suffix}`, asset_key: 'accessory-hat-v1' });
  const snow = await buyFixture(page, { type: 'effect', name: `下雪-${suffix}`, asset_key: 'effect-snow-v1' });
  const sparkle = await buyFixture(page, { type: 'effect', name: `闪光-${suffix}`, asset_key: 'effect-sparkle-v1' });
  await page.reload();
  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await page.getByRole('button', { name: shop.wardrobe, exact: true }).click();
  for (const item of [background, star, hat, snow, sparkle]) {
    await page.getByRole('button', { name: `${shop.equip} ${item.name_snapshot}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `${shop.unequip} ${item.name_snapshot}`, exact: true })).toBeEnabled();
  }
  const equipped = (await api<Camp>(page, '/camp')).equipment;
  expect(equipped.background?.id).toBe(background.id);
  expect(equipped.accessories).toHaveLength(2);
  expect(equipped.effects.map((item) => item.id).sort()).toEqual([snow.id, sparkle.id].sort());

  await page.getByRole('button', { name: shop.editOutfit, exact: true }).click();
  const editor = page.getByRole('dialog');
  const selection = editor.getByLabel(shop.selectedAccessory, { exact: true });
  await selection.selectOption(star.id);
  await expect(selection.locator('option')).toHaveCount(2);
  const stage = editor.locator('.shop-character-stage');
  const starArt = stage.locator(`[data-purchase-id="${star.id}"]`);
  const starHandle = stage.getByRole('button', { name: `${shop.selectAccessory} ${star.name_snapshot}`, exact: true });
  await starHandle.hover();
  await expectAccessoryAligned(starHandle, starArt);
  await page.mouse.down();
  await expectAccessoryAligned(starHandle, starArt);
  await page.mouse.up();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectAccessoryAligned(starHandle, starArt);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (isMobile) {
    await editor.getByRole('button', { name: shop.moveRight, exact: true }).click();
    await editor.getByRole('button', { name: shop.moveDown, exact: true }).click();
  } else {
    await starArt.scrollIntoViewIfNeeded();
    const box = await starArt.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2 + 45, { steps: 5 });
    await page.mouse.up();
  }
  const size = editor.getByLabel(shop.accessorySize);
  const originalSize = Number(await size.inputValue());
  await size.focus();
  await size.press('ArrowRight');
  await size.press('ArrowRight');
  expect(Number(await size.inputValue())).toBeGreaterThan(originalSize);
  await editor.getByRole('button', { name: shop.layerDown, exact: true }).click();
  await expect(stage).toBeInViewport({ ratio: 0.9 });
  await saveLayout(page, star.id);
  const behind = (await api<Camp>(page, '/camp')).equipment;
  const behindLayout = behind.accessory_layouts[star.id]!;
  expect(behindLayout.layer).toBeLessThan(0);
  expect(behindLayout.x).toBeGreaterThan(equipped.accessory_layouts[star.id]!.x);
  expect(behindLayout.y).toBeGreaterThan(equipped.accessory_layouts[star.id]!.y);
  expect(behindLayout.size).toBeGreaterThan(equipped.accessory_layouts[star.id]!.size);
  expect(behind.accessory_layouts[hat.id]).toMatchObject({
    x: equipped.accessory_layouts[hat.id]!.x,
    y: equipped.accessory_layouts[hat.id]!.y,
    size: equipped.accessory_layouts[hat.id]!.size,
  });

  // 连续向上跨过角色和另一件饰品，再连续向下；不用置顶替代逐层行为。
  await editor.getByRole('button', { name: shop.layerUp, exact: true }).click();
  await editor.getByRole('button', { name: shop.layerUp, exact: true }).click();
  await saveLayout(page, star.id);
  const front = (await api<Camp>(page, '/camp')).equipment;
  expect(front.accessory_layouts[star.id]!.layer).toBeGreaterThan(front.accessory_layouts[hat.id]!.layer);
  await editor.getByRole('button', { name: shop.layerDown, exact: true }).click();
  await editor.getByRole('button', { name: shop.layerDown, exact: true }).click();
  await expect(stage).toBeInViewport({ ratio: 0.9 });
  await saveLayout(page, star.id);
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await editor.screenshot({ path: `.local/previews/outfit-editor-${suffix}.png` });
  await editor.getByRole('button', { name: shop.close, exact: true }).first().click();
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await page.locator('.shop-character').screenshot({ path: `.local/previews/outfit-wardrobe-${suffix}.png` });

  await page.reload();
  const restored = (await api<Camp>(page, '/camp')).equipment;
  expect(restored).toEqual(behind);
  const character = page.locator('.shop-character');
  await expect(character.getByRole('img', { name: background.name_snapshot, exact: true })).toBeVisible();
  await expect(character.getByRole('img', { name: snow.name_snapshot, exact: true })).toHaveAttribute('src', '/api/v1/assets/effect-snow-v1');
  const homeStar = character.locator(`[data-purchase-id="${star.id}"]`);
  await expect(homeStar).toBeVisible();
  expect(await homeStar.evaluate((image) => Number(getComputedStyle(image).zIndex)))
    .toBeLessThan(await character.locator('.shop-avatar-art').evaluate((image) => Number(getComputedStyle(image).zIndex)));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const reduceMotion = page.getByLabel(family.reduceMotion, { exact: true });
  await openConfigurationSettings(page);
  await reduceMotion.click();
  await expect(reduceMotion).toBeChecked();
  await closeConfigurationSettings(page);
  await expect(character.getByRole('img', { name: snow.name_snapshot, exact: true })).toHaveAttribute('src', '/api/v1/assets/effect-snow-v1?motion=static');
  await expect(character.getByRole('img', { name: sparkle.name_snapshot, exact: true })).toHaveAttribute('src', '/api/v1/assets/effect-sparkle-v1?motion=static');
  await expect.poll(() => character.locator('img').evaluateAll((images) => images.every((image) =>
    (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await character.screenshot({ path: `.local/previews/outfit-${suffix}.png` });
  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await page.getByRole('button', { name: shop.wardrobe, exact: true }).click();
  await page.getByRole('button', { name: shop.editOutfit, exact: true }).click();
  await selection.selectOption(star.id);
  await starHandle.hover();
  await expectAccessoryAligned(starHandle, starArt);
  await page.mouse.down();
  await expectAccessoryAligned(starHandle, starArt);
  await page.mouse.up();
  await editor.getByRole('button', { name: shop.close, exact: true }).first().click();
  await openConfigurationSettings(page);
  await reduceMotion.click();
  await expect(reduceMotion).not.toBeChecked();
  await closeConfigurationSettings(page);
  await page.getByRole('button', { name: shop.wardrobe, exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(character.getByRole('img', { name: snow.name_snapshot, exact: true })).toHaveAttribute('src', '/api/v1/assets/effect-snow-v1?motion=static');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await page.getByRole('button', { name: shop.wardrobe, exact: true }).click();
  await page.getByRole('button', { name: `${shop.unequip} ${star.name_snapshot}`, exact: true }).click();
  await page.getByRole('button', { name: `${shop.equip} ${star.name_snapshot}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${shop.unequip} ${star.name_snapshot}`, exact: true })).toBeEnabled();
  const reequipped = (await api<Camp>(page, '/camp')).equipment;
  expect(reequipped.accessory_layouts[star.id]).toMatchObject({ x: behindLayout.x, y: behindLayout.y, size: behindLayout.size });
  expect(reequipped.accessory_layouts[star.id]!.layer).toBeGreaterThan(reequipped.accessory_layouts[hat.id]!.layer);
  await page.getByRole('button', { name: `${shop.unequip} ${snow.name_snapshot}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${shop.equip} ${snow.name_snapshot}`, exact: true })).toBeEnabled();
  const afterRemoval = (await api<Camp>(page, '/camp')).equipment;
  expect(afterRemoval.effects.map((item) => item.id)).toEqual([sparkle.id]);
  const owned = await api<{ items: Purchase[] }>(page, '/purchases?type=effect&status=owned');
  expect(owned.items.some((item) => item.id === snow.id)).toBe(true);
});
