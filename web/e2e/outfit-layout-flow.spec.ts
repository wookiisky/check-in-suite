import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import family from '../src/features/family/content.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import { closeConfigurationSettings, openConfigurationSettings } from './configuration-navigation';
import { closeWardrobe, openWardrobe } from './shop-navigation';

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
  await page.getByRole('dialog', { name: shop.editOutfit, exact: true }).getByRole('button', { name: shop.save, exact: true }).click();
  expect((await response).ok()).toBeTruthy();
  await expect(page.getByRole('dialog', { name: shop.editOutfit, exact: true }).getByRole('button', { name: shop.save, exact: true })).toBeDisabled();
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

// 拖动实际控件并跨过多个指针事件，验证捕获后的连续更新。
async function dragControl(page: Page, control: Locator, dx: number, dy: number) {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

// 从旋转手柄的实际位置绕素材中心顺时针转动45°。
async function rotateAccessory(page: Page, control: Locator, artwork: Locator) {
  await control.scrollIntoViewIfNeeded();
  const handle = await control.boundingBox();
  const image = await artwork.boundingBox();
  expect(handle).not.toBeNull();
  expect(image).not.toBeNull();
  const centerX = image!.x + image!.width / 2;
  const centerY = image!.y + image!.height / 2;
  const x = handle!.x + handle!.width / 2;
  const y = handle!.y + handle!.height / 2;
  const angle = Math.PI / 4;
  const dx = x - centerX;
  const dy = y - centerY;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(centerX + dx * Math.cos(angle) - dy * Math.sin(angle), centerY + dx * Math.sin(angle) + dy * Math.cos(angle), { steps: 8 });
  await page.mouse.up();
}

// 坐标点击经过浏览器实际命中，手机项目同时检查触摸点击。
async function clickStagePoint(page: Page, stage: Locator, x: number, y: number) {
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box!.x + box!.width * x, y: box!.y + box!.height * y };
  if (test.info().project.use.hasTouch) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

// 重选当前项不会产生 change，原生键盘操作仍须恢复一次优先操作。
async function reselectCurrent(selection: Locator) {
  const index = await selection.evaluate((element) => (element as HTMLSelectElement).selectedIndex);
  await selection.focus();
  await selection.press(index === 0 ? 'Home' : 'End');
}

test('点击切换饰品，下拉框为遮挡对象提供一次优先操作', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
  const initial = await api<Camp>(page, '/camp');
  for (const item of initial.equipment.accessories) await api(page, `/equipment/accessories/${item.id}`, 'DELETE');
  for (const item of initial.equipment.effects) await api(page, `/equipment/effects/${item.id}`, 'DELETE');
  const suffix = testInfo.project.name;
  const earning = await api<{ id: string; version: number }>(page, '/management/tasks', 'POST', {
    category_id: null, name: `饰品选择准备-${suffix}`, icon_key: 'book-v1',
    coin_reward: Math.max(1, -initial.wallet.coins), diamond_reward: Math.max(1, -initial.wallet.diamonds),
    daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true,
  });
  await api(page, '/checkins', 'POST', {
    expected_today: initial.today, task_id: earning.id, expected_task_version: earning.version,
    text: '', photo_media_id: null, audio_media_id: null,
  });
  const back = await buyFixture(page, { type: 'accessory', name: `后方饰品-${suffix}`, asset_key: 'accessory-star-v1' });
  const front = await buyFixture(page, { type: 'accessory', name: `前方饰品-${suffix}`, asset_key: 'accessory-hat-v1' });
  for (const item of [back, front]) await api(page, `/equipment/accessories/${item.id}`, 'PUT');
  await api(page, `/equipment/accessories/${back.id}/layout`, 'PATCH', { x: 0.5, y: 0.5, size: 0.3, rotation: 0, before_id: null });
  await api(page, `/equipment/accessories/${front.id}/layout`, 'PATCH', { x: 0.5, y: 0.5, size: 0.6, rotation: 0, before_id: null });
  await page.reload();
  await openWardrobe(page);
  await page.getByRole('button', { name: shop.editOutfit, exact: true }).click();
  const editor = page.getByRole('dialog', { name: shop.editOutfit, exact: true });
  const selection = editor.getByLabel(shop.selectedAccessory, { exact: true });
  const stage = editor.locator('.shop-character-stage');
  const backHandle = stage.getByRole('button', { name: `${shop.selectAccessory} ${back.name_snapshot}`, exact: true });
  const frontHandle = stage.getByRole('button', { name: `${shop.selectAccessory} ${front.name_snapshot}`, exact: true });
  const backArt = stage.locator(`[data-purchase-id="${back.id}"]`);
  const frontArt = stage.locator(`[data-purchase-id="${front.id}"]`);
  await selection.selectOption(back.id);
  await reselectCurrent(selection);
  await clickStagePoint(page, stage, 0.5, 0.5);
  await expect(selection).toHaveValue(back.id);
  await expect(editor.getByRole('button', { name: shop.save, exact: true })).toBeDisabled();
  // 消费一次优先后，已选后方饰品不能继续遮住前方饰品的点击区域。
  await expect.poll(() => frontHandle.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
  })).toBe(true);
  await clickStagePoint(page, stage, 0.5, 0.5);
  await expect(selection).toHaveValue(front.id);

  await selection.selectOption(back.id);
  await reselectCurrent(selection);
  // 优先只覆盖所选物体自己的范围，外侧仍能直接点击前方物体。
  await clickStagePoint(page, stage, 0.75, 0.5);
  await expect(selection).toHaveValue(front.id);
  await selection.selectOption(back.id);
  await clickStagePoint(page, stage, 0.5, 0.5);
  await expect(selection).toHaveValue(back.id);
  await expect.poll(() => frontHandle.evaluate((element) => Number(element.style.zIndex))).toBeGreaterThan(await backHandle.evaluate((element) => Number(element.style.zIndex)));
  // 用真实指针打开原生下拉框后保持当前项，也能重新操作被遮挡的饰品。
  await selection.click();
  await page.keyboard.press('Enter');
  await clickStagePoint(page, stage, 0.5, 0.5);
  await expect(selection).toHaveValue(back.id);
  await expect.poll(() => frontHandle.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
  })).toBe(true);
  await reselectCurrent(selection);
  await stage.scrollIntoViewIfNeeded();
  await expect.poll(() => backHandle.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
  })).toBe(true);

  // 拖动期间优先权已消费，但捕获必须让后续事件始终修改后方饰品。
  await dragControl(page, backHandle, 12, 8);
  await expect(selection).toHaveValue(back.id);
  const movedLeft = await backArt.evaluate((element) => element.style.left);
  expect(Number.parseFloat(movedLeft)).toBeGreaterThan(50);
  await expect.poll(() => frontArt.evaluate((element) => element.style.left)).toBe('50%');
  await clickStagePoint(page, stage, 0.5, 0.5);
  const discard = page.getByRole('dialog', { name: shop.discardChanges, exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: shop.keepEditing, exact: true }).click();
  await expect(selection).toHaveValue(back.id);
  await expect.poll(() => backArt.evaluate((element) => element.style.left)).toBe(movedLeft);
  await clickStagePoint(page, stage, 0.5, 0.5);
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: shop.discard, exact: true }).click();
  await expect(selection).toHaveValue(front.id);
  await expect.poll(() => backArt.evaluate((element) => element.style.left)).toBe('50%');
});

// 两个浏览器项目都拖动素材与手柄，并通过真实保存、刷新和重装备核对结果。
test('背景、可编辑饰品和固定特效在保存刷新后保持组合', async ({ page }, testInfo) => {
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
  await openWardrobe(page);
  for (const item of [background, star, hat, snow, sparkle]) {
    await page.getByRole('button', { name: `${shop.equip} ${item.name_snapshot}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `${shop.unequip} ${item.name_snapshot}`, exact: true })).toBeEnabled();
  }
  const equipped = (await api<Camp>(page, '/camp')).equipment;
  expect(equipped.background?.id).toBe(background.id);
  expect(equipped.accessories).toHaveLength(2);
  expect(equipped.effects.map((item) => item.id).sort()).toEqual([snow.id, sparkle.id].sort());

  await page.getByRole('button', { name: shop.editOutfit, exact: true }).click();
  const editor = page.getByRole('dialog', { name: shop.editOutfit, exact: true });
  const selection = editor.getByLabel(shop.selectedAccessory, { exact: true });
  await selection.selectOption(star.id);
  await expect(selection.locator('option')).toHaveCount(2);
  const stage = editor.locator('.shop-character-stage');
  const starArt = stage.locator(`[data-purchase-id="${star.id}"]`);
  const starHandle = stage.getByRole('button', { name: `${shop.selectAccessory} ${star.name_snapshot}`, exact: true });
  const resizeHandle = stage.locator('[data-transform="resize"][data-corner="se"]');
  const rotateHandle = stage.locator('[data-transform="rotate"]');
  await expect(editor.getByRole('slider')).toHaveCount(0);
  for (const name of [shop.moveLeft, shop.moveRight, shop.moveUp, shop.moveDown]) {
    await expect(editor.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  // 最小饰品的中心仍须命中移动层，外侧缩放手柄不能遮住素材。
  await resizeHandle.focus();
  await resizeHandle.press('Home');
  await expect.poll(() => starArt.evaluate((image) => image.style.width)).toBe('5%');
  await expectAccessoryAligned(starHandle, starArt);
  await expect.poll(() => starHandle.evaluate((handle) => {
    const box = handle.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === handle;
  })).toBe(true);
  const minimumLeft = await starArt.evaluate((image) => Number.parseFloat(image.style.left));
  await dragControl(page, starHandle, 6, 6);
  await expect.poll(() => starArt.evaluate((image) => Number.parseFloat(image.style.left))).toBeGreaterThan(minimumLeft);
  await editor.getByRole('button', { name: shop.cancel, exact: true }).click();
  await expect.poll(() => starArt.evaluate((image) => image.style.width)).toBe(`${equipped.accessory_layouts[star.id]!.size * 100}%`);
  await starHandle.hover();
  await expectAccessoryAligned(starHandle, starArt);
  await page.mouse.down();
  await expectAccessoryAligned(starHandle, starArt);
  await page.mouse.up();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectAccessoryAligned(starHandle, starArt);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await dragControl(page, starHandle, 30, 30);
  await dragControl(page, resizeHandle, 12, 12);
  await rotateAccessory(page, rotateHandle, starArt);
  await expectAccessoryAligned(starHandle, starArt);
  await editor.getByRole('button', { name: shop.layerDown, exact: true }).click();
  await expect(stage).toBeInViewport({ ratio: 0.9 });
  // 暂停实际保存请求，在写入期间按 Escape 不得绕过编辑器的关闭限制。
  let resumeSave!: () => void;
  const savingGate = new Promise<void>((resolve) => { resumeSave = resolve; });
  const layoutPath = `**/equipment/accessories/${star.id}/layout`;
  await page.route(layoutPath, async (route) => { await savingGate; await route.continue(); });
  const saving = saveLayout(page, star.id);
  try {
    await expect(editor.getByRole('button', { name: shop.saving, exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(editor).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(2);
  } finally {
    resumeSave();
    await saving;
    await page.unroute(layoutPath);
  }
  const behind = (await api<Camp>(page, '/camp')).equipment;
  const behindLayout = behind.accessory_layouts[star.id]!;
  expect(behindLayout.layer).toBeLessThan(0);
  expect(behindLayout.x).toBeGreaterThan(equipped.accessory_layouts[star.id]!.x);
  expect(behindLayout.y).toBeGreaterThan(equipped.accessory_layouts[star.id]!.y);
  expect(behindLayout.size).toBeGreaterThan(equipped.accessory_layouts[star.id]!.size);
  expect(behindLayout.rotation).toBeGreaterThan(40);
  expect(behindLayout.rotation).toBeLessThan(50);
  expect(behind.accessory_layouts[hat.id]).toMatchObject({
    x: equipped.accessory_layouts[hat.id]!.x,
    y: equipped.accessory_layouts[hat.id]!.y,
    size: equipped.accessory_layouts[hat.id]!.size,
    rotation: equipped.accessory_layouts[hat.id]!.rotation,
  });

  // 连续向上跨过角色和另一件饰品，再连续向下；不用置顶替代逐层行为。
  await editor.getByRole('button', { name: shop.layerUp, exact: true }).click();
  await editor.getByRole('button', { name: shop.layerUp, exact: true }).click();
  await saveLayout(page, star.id);
  const front = (await api<Camp>(page, '/camp')).equipment;
  expect(front.accessory_layouts[star.id]!.layer).toBeGreaterThan(front.accessory_layouts[hat.id]!.layer);
  expect(front.accessory_layouts[star.id]).toMatchObject({
    x: behindLayout.x, y: behindLayout.y, size: behindLayout.size, rotation: behindLayout.rotation,
  });
  await editor.getByRole('button', { name: shop.layerDown, exact: true }).click();
  await editor.getByRole('button', { name: shop.layerDown, exact: true }).click();
  await expect(stage).toBeInViewport({ ratio: 0.9 });
  await saveLayout(page, star.id);
  // Escape 只处理最上层的饰品草稿，继续编辑后同一位置仍然保留。
  await starHandle.focus();
  await starHandle.press('ArrowRight');
  const unsavedLeft = await starArt.evaluate((image) => image.style.left);
  await page.keyboard.press('Escape');
  const discard = page.getByRole('dialog', { name: shop.discardChanges, exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: shop.keepEditing, exact: true }).click();
  await expect(editor).toBeVisible();
  await expect.poll(() => starArt.evaluate((image) => image.style.left)).toBe(unsavedLeft);
  await editor.getByRole('button', { name: shop.cancel, exact: true }).click();
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await editor.screenshot({ path: `.local/previews/outfit-editor-${suffix}.png` });
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: shop.wardrobeTitle, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: shop.editOutfit, exact: true })).toBeFocused();
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await page.getByRole('dialog', { name: shop.wardrobeTitle, exact: true }).locator('.shop-character').screenshot({ path: `.local/previews/outfit-wardrobe-${suffix}.png` });

  await page.reload();
  const restored = (await api<Camp>(page, '/camp')).equipment;
  expect(restored).toEqual(behind);
  const character = page.locator('.camp-character-panel > .shop-character');
  await expect(character.getByRole('img', { name: background.name_snapshot, exact: true })).toBeVisible();
  await expect(character.getByRole('img', { name: snow.name_snapshot, exact: true })).toHaveAttribute('src', '/api/v1/assets/effect-snow-v1');
  const homeStar = character.locator(`[data-purchase-id="${star.id}"]`);
  await expect(homeStar).toBeVisible();
  const restoredRotation = await homeStar.evaluate((image) => {
    const transform = new DOMMatrix(getComputedStyle(image).transform);
    return (Math.atan2(transform.b, transform.a) * 180 / Math.PI + 360) % 360;
  });
  expect(restoredRotation).toBeCloseTo(behindLayout.rotation, 3);
  expect(await homeStar.evaluate((image) => Number(getComputedStyle(image).zIndex)))
    .toBeLessThan(await character.locator('.shop-avatar-art').evaluate((image) => Number(getComputedStyle(image).zIndex)));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const reduceMotion = page.getByLabel(family.reduceMotion, { exact: true });
  await closeWardrobe(page);
  await openConfigurationSettings(page);
  await reduceMotion.click();
  await expect(reduceMotion).toBeChecked();
  await closeConfigurationSettings(page);
  await expect(character.getByRole('img', { name: snow.name_snapshot, exact: true })).toHaveAttribute('src', '/api/v1/assets/effect-snow-v1?motion=static');
  await expect(character.getByRole('img', { name: sparkle.name_snapshot, exact: true })).toHaveAttribute('src', '/api/v1/assets/effect-sparkle-v1?motion=static');
  await expect.poll(() => character.locator('img').evaluateAll((images) => images.every((image) =>
    (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await character.screenshot({ path: `.local/previews/outfit-${suffix}.png` });
  await openWardrobe(page);
  await page.getByRole('button', { name: shop.editOutfit, exact: true }).click();
  await selection.selectOption(star.id);
  await starHandle.hover();
  await expectAccessoryAligned(starHandle, starArt);
  await page.mouse.down();
  await expectAccessoryAligned(starHandle, starArt);
  await page.mouse.up();
  await editor.getByRole('button', { name: shop.close, exact: true }).first().click();
  await closeWardrobe(page);
  await openConfigurationSettings(page);
  await reduceMotion.click();
  await expect(reduceMotion).not.toBeChecked();
  await closeConfigurationSettings(page);
  await openWardrobe(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(character.getByRole('img', { name: snow.name_snapshot, exact: true })).toHaveAttribute('src', '/api/v1/assets/effect-snow-v1?motion=static');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await openWardrobe(page);
  await page.getByRole('button', { name: `${shop.unequip} ${star.name_snapshot}`, exact: true }).click();
  await page.getByRole('button', { name: `${shop.equip} ${star.name_snapshot}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${shop.unequip} ${star.name_snapshot}`, exact: true })).toBeEnabled();
  const reequipped = (await api<Camp>(page, '/camp')).equipment;
  expect(reequipped.accessory_layouts[star.id]).toMatchObject({ x: behindLayout.x, y: behindLayout.y, size: behindLayout.size, rotation: behindLayout.rotation });
  expect(reequipped.accessory_layouts[star.id]!.layer).toBeGreaterThan(reequipped.accessory_layouts[hat.id]!.layer);
  await page.getByRole('button', { name: `${shop.unequip} ${snow.name_snapshot}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${shop.equip} ${snow.name_snapshot}`, exact: true })).toBeEnabled();
  const afterRemoval = (await api<Camp>(page, '/camp')).equipment;
  expect(afterRemoval.effects.map((item) => item.id)).toEqual([sparkle.id]);
  const owned = await api<{ items: Purchase[] }>(page, '/purchases?type=effect&status=owned');
  expect(owned.items.some((item) => item.id === snow.id)).toBe(true);
});
