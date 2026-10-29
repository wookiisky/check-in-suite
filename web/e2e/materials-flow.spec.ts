import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import island from '../src/features/island/content.json' with { type: 'json' };

type Camp = components['schemas']['CampResponse'];
type Product = components['schemas']['Product'];
type IslandState = components['schemas']['IslandState'];
type Session = components['schemas']['SessionResponse'];

// 准备和持久化断言沿用浏览器的真实登录会话及写请求保护。
async function api<T>(page: Page, path: string, method = 'GET', data?: unknown): Promise<T> {
  const session = await (await page.request.get('/api/v1/session')).json() as Session;
  const response = await page.request.fetch(`/api/v1${path}`, {
    method, data,
    headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.status() === 204 ? undefined as T : response.json() as Promise<T>;
}

// 用实际管理表单选择新增素材并上架，不用 API 绕过素材选择器。
async function createOffer(page: Page, type: Product['type'], assetKey: string, name: string): Promise<Product> {
  await page.getByRole('button', { name: shop.addProduct, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(shop.name, { exact: true }).fill(name);
  await dialog.getByRole('combobox', { name: shop.typeFilter, exact: true }).selectOption(type);
  await dialog.getByRole('combobox', { name: shop.asset, exact: true }).selectOption(assetKey);
  await expect(dialog.getByRole('combobox', { name: shop.asset, exact: true })).toHaveValue(assetKey);
  await dialog.getByLabel(shop.coinPrice, { exact: true }).fill('1');
  await dialog.getByLabel(shop.diamondPrice, { exact: true }).fill('0');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/v1/management/products') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: shop.save, exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBeTruthy();
  await expect(dialog).toHaveCount(0);
  return response.json() as Promise<Product>;
}

// 购买与装备由页面执行，同时验证购买后不会自动装备。
async function buyAndEquip(page: Page, product: Product) {
  await page.getByRole('button', { name: shop.browse, exact: true }).click();
  await page.getByRole('button', { name: `${shop.buy} ${product.name}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `${shop.equip} ${product.name}`, exact: true })).toBeEnabled();
  await page.getByRole('button', { name: `${shop.equip} ${product.name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${shop.unequip} ${product.name}`, exact: true })).toBeEnabled();
}

// 不同角色共用完整流程，名称与角色标识保证共享数据库中的测试数据互不冲突。
for (const character of [
  { key: 'red-panda-v1', name: '小熊猫', preview: 'materials' },
  { key: 'avatar-girl-braids-v1', name: '双辫女孩', preview: 'human' },
  { key: 'avatar-boy-afro-v1', name: '爆炸头男孩', preview: 'human-boy' },
]) {
  test(`${character.name}素材可在管理页选择并持久展示于画像和小岛`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    const loadedAssets = new Set<string>();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/v1/assets/') && response.ok() && response.headers()['content-type']?.includes('image/svg+xml')) {
        loadedAssets.add(url.pathname);
      }
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByLabel(content.account.username).fill('island-e2e');
    await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
    await page.getByRole('button', { name: content.account.login, exact: true }).click();
    await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
    await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
    await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
    await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();

    const browser = testInfo.project.name === 'desktop-chromium' ? '桌面' : '手机';
    const suffix = `${browser}-${character.key}`;
    const before = await api<Camp>(page, '/camp');
    const task = await api<components['schemas']['Task']>(page, '/management/tasks', 'POST', {
      category_id: null, name: `素材准备-${suffix}`, icon_key: 'water-v1',
      coin_reward: Math.max(10, 10 - before.wallet.coins), diamond_reward: Math.max(1, -before.wallet.diamonds),
      daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true,
    });
    await api(page, '/checkins', 'POST', {
      expected_today: before.today, task_id: task.id, expected_task_version: task.version,
      text: '', photo_media_id: null, audio_media_id: null,
    });
    for (const item of before.equipment.accessories) await api(page, `/equipment/accessories/${item.id}`, 'DELETE');
    for (const item of before.equipment.effects) await api(page, `/equipment/effects/${item.id}`, 'DELETE');
    await api(page, '/account/preferences', 'PATCH', { reduce_motion: true });
    const initial = await api<IslandState>(page, '/island');
    await api(page, '/island', 'PUT', {
      expected_version: initial.version,
      placements: [
        { id: 'base:house', item_key: 'house', x: -3, y: -2, rotation: 0, zone: 'outdoor' },
        { id: 'base:desk', item_key: 'desk', x: 0, y: 0, rotation: 0, zone: 'indoor' },
        { id: 'base:run', item_key: 'run', x: 3, y: 2, rotation: 0, zone: 'outdoor' },
        { id: 'base:environment', item_key: 'day', x: 0, y: 0, rotation: 0, zone: 'outdoor' },
      ],
    });

    await page.getByRole('button', { name: content.navigation.products, exact: true }).click();
    const avatar = await createOffer(page, 'avatar', character.key, `${character.name}素材-${suffix}`);
    const background = await createOffer(page, 'background', 'background-sakura-v1', `樱花素材-${suffix}`);
    const accessory = await createOffer(page, 'accessory', 'accessory-flower-crown-v1', `花环素材-${suffix}`);
    const windmill = await createOffer(page, 'island', 'island-windmill-v1', `风车素材-${suffix}`);
    expect(windmill.island_item_key).toBe('windmill');
    expect(windmill.repeatable).toBe(true);

    await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
    for (const product of [avatar, background, accessory]) await buyAndEquip(page, product);
    const stage = page.locator('.shop-character');
    for (const product of [avatar, background, accessory]) {
      await expect(stage.getByRole('img', { name: product.name, exact: true })).toBeVisible();
    }
    await expect.poll(() => stage.locator('img').evaluateAll((images) => images.every((image) =>
      (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);

    await page.getByRole('button', { name: shop.construction, exact: true }).click();
    await page.getByRole('button', { name: `${shop.buy} ${windmill.name}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const owned = await api<IslandState>(page, '/island');
    const added = owned.inventory.find((item) => item.item_key === 'windmill' && !initial.inventory.some((old) => old.id === item.id));
    expect(added).toBeDefined();
    await page.getByRole('button', { name: shop.goToIsland, exact: true }).click();
    const scene = page.getByRole('group', { name: island.scene, exact: true });
    await expect(scene).toBeVisible();
    await expect(scene.locator('.island-character-art image')).toHaveAttribute('href', `/api/v1/assets/${character.key}`);
    await expect(scene.locator('.island-character-art')).toHaveAttribute('data-static', 'true');
    await page.getByRole('button', { name: island.edit, exact: true }).click();
    await page.locator(`[data-inventory-id="${added!.id}"]`).getByRole('button').click();
    const art = scene.locator(`[data-placement-id="${added!.id}"] .island-item-art`);
    await expect(art.locator('.island-windmill-blades')).toBeVisible();
    await expect(art).toHaveAttribute('data-animation', 'spin');
    await expect(art).toHaveAttribute('data-static', 'true');
    await page.getByRole('button', { name: island.save, exact: true }).click();
    await expect(page.getByText(island.saved, { exact: true })).toBeVisible();
    const saved = await api<IslandState>(page, '/island');
    expect(saved.placements.some((item) => item.id === added!.id && item.item_key === 'windmill')).toBe(true);

    for (const asset of [avatar, background, accessory, windmill]) {
      await expect.poll(() => loadedAssets.has(`/api/v1/assets/${asset.asset_key}`)).toBe(true);
    }
    // 角色图片与商店风车缩略图仍需可解码，小岛风车则使用分部件模型。
    for (const url of [`/api/v1/assets/${character.key}`, `/api/v1/assets/${windmill.asset_key}`]) {
      expect(await page.evaluate(async (source) => {
        const decoded = new Image();
        decoded.src = source;
        await decoded.decode();
        return decoded.naturalWidth > 0 && decoded.naturalHeight > 0;
      }, url)).toBe(true);
    }
    const equipment = (await api<Camp>(page, '/camp')).equipment;
    expect(equipment.avatar?.asset_key_snapshot).toBe(character.key);
    expect(equipment.background?.asset_key_snapshot).toBe('background-sakura-v1');
    expect(equipment.accessories.map((item) => item.asset_key_snapshot)).toContain('accessory-flower-crown-v1');

    await page.reload();
    await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
    await expect(scene.locator('.island-character-art image')).toHaveAttribute('href', `/api/v1/assets/${character.key}`);
    await expect(art.locator('.island-windmill-blades')).toBeVisible();
    await expect(art).toHaveAttribute('data-animation', 'spin');
    await expect(art).toHaveAttribute('data-static', 'true');
    expect((await api<IslandState>(page, '/island')).placements).toEqual(saved.placements);
    expect((await api<Camp>(page, '/camp')).equipment).toEqual(equipment);
    await page.screenshot({ path: testInfo.outputPath(`${character.preview}-island.png`) });
    expect(errors).toEqual([]);
    await api(page, '/account/preferences', 'PATCH', { reduce_motion: before.account.preferences.reduce_motion });
  });
}
