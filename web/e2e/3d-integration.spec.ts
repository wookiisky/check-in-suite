import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import family from '../src/features/family/content.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import appearance from '../src/features/shop/appearance-content.json' with { type: 'json' };
import character from '../src/features/character/character-panel-content.json' with { type: 'json' };
import titles from '../src/features/character/title-picker-content.json' with { type: 'json' };
import spatial from '../src/features/island/three/spatial-content.json' with { type: 'json' };
import { appearanceRequest } from './appearance-flow-fixtures';
import { readSpatial, spatialRequest } from './island-3d-fixtures';
import { loginMain, shopAPI, selectShopCategory, purchaseProduct, openBackpack, goHome, closeAppearance } from './shop-navigation';

type Product = components['schemas']['Product'];
type Appearance = components['schemas']['AppearanceState'];
type Task = components['schemas']['Task'];
type Checkin = components['schemas']['Checkin'];
type Camp = components['schemas']['CampResponse'];
type Funding = { task: Task; record: Checkin };

test.setTimeout(120_000);
test.use({ actionTimeout: 15_000 });

// 余额来自真实打卡奖励，购买仍由页面提交完整价格和版本。
async function fundPurchase(page: Page, product: Product, name: string): Promise<Funding> {
  await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
  const camp = await shopAPI<Camp>(page, '/camp');
  const task = await shopAPI<Task>(page, '/management/tasks', 'POST', { category_id: null, name, icon_key: 'book-v1', coin_reward: Math.max(1, product.coin_price - camp.wallet.coins), diamond_reward: Math.max(1, product.diamond_price - camp.wallet.diamonds), daily_limit: 2, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true });
  const result = await shopAPI<components['schemas']['CheckinResult']>(page, '/checkins', 'POST', { expected_today: camp.today, task_id: task.id, expected_task_version: task.version, text: '', photo_media_id: null, audio_media_id: null });
  await shopAPI(page, '/management/lock', 'POST');
  return { task, record: result.checkin };
}

// 还原任务与资格，不直接修改账本或伪造购买撤销。
async function clearFunding(page: Page, funding: Funding | null) {
  if (!funding) return;
  await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
  await shopAPI(page, `/checkins/${funding.record.id}`, 'DELETE', { expected_version: funding.record.version });
  await shopAPI(page, `/management/tasks/${funding.task.id}`, 'DELETE', { expected_version: funding.task.version });
  await shopAPI(page, '/management/lock', 'POST');
}

// 服装报价用稳定目录身份，购买后保留分类，只有整套外观保存才改变人物。
test('真实购买服装不自动换装，背包与首页共享外观且保留任务和留言DOM', async ({ page }, testInfo) => {
  await loginMain(page);
  const original = await shopAPI<Appearance>(page, '/appearance');
  let funding: Funding | null = null;
  try {
    const body = original.characters.find((item) => item.character_key === original.character_key)!;
    const products = (await shopAPI<components['schemas']['ProductList']>(page, '/products?type=wearable')).items;
    const product = products.find((item) => {
      const definition = original.wearables.find((wearable) => wearable.wearable_key === item.wearable_key);
      return definition && definition.wearable_key !== body.defaults[definition.slot] && !original.inventory.some((owned) => owned.wearable_key === definition.wearable_key);
    })!;
    expect(product).toBeDefined();
    const wearable = original.wearables.find((item) => item.wearable_key === product.wearable_key)!;
    funding = await fundPurchase(page, product, `三维购买准备-${testInfo.project.name}`);
    await selectShopCategory(page, 'appearance', shop.wearableSlots[wearable.slot]);
    const before = await shopAPI<Camp>(page, '/camp');
    await purchaseProduct(page, product);
    await expect(page.getByRole('tab', { name: shop.wearableSlots[wearable.slot], exact: true })).toHaveAttribute('aria-selected', 'true');
    const purchased = await shopAPI<Appearance>(page, '/appearance');
    expect(appearanceRequest(purchased)).toEqual(appearanceRequest(original));
    const camp = await shopAPI<Camp>(page, '/camp');
    expect(camp.wallet.coins).toBe(before.wallet.coins - product.coin_price);
    expect(camp.wallet.diamonds).toBe(before.wallet.diamonds - product.diamond_price);
    const owned = purchased.inventory.find((item) => item.wearable_key === wearable.wearable_key)!;
    await openBackpack(page);
    await page.getByRole('button', { name: shop.wardrobeTitle, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: appearance.title, exact: true });
    await dialog.getByRole('group', { name: appearance.slots[wearable.slot], exact: true }).getByRole('radio', { name: wearable.name, exact: true }).check();
    await dialog.getByRole('button', { name: appearance.save, exact: true }).click();
    await expect(dialog.getByText(appearance.saved, { exact: true })).toBeVisible();
    const saved = await shopAPI<Appearance>(page, '/appearance');
    expect(saved[`${wearable.slot}_purchase_id`]).toBe(owned.purchase_id);
    await closeAppearance(page);
    await goHome(page);
    const panel = page.getByRole('region', { name: character.label, exact: true });
    const preview = panel.locator('.character3d-preview');
    await expect(preview).toHaveAttribute('data-appearance-version', String(saved.version));
    await expect(preview).toHaveAttribute('data-character-status', 'ready');
    const message = page.getByLabel(family.input, { exact: true });
    await message.fill('换装期间保留的家庭留言草稿');
    const messageNode = await message.elementHandle();
    const task = page.locator('.checkin-task').filter({ hasText: funding.task.name });
    await expect(task).toBeVisible();
    const taskNode = await task.elementHandle();
    const reads: string[] = [];
    page.on('request', (request) => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/v1/camp') reads.push(request.url()); });
    await panel.getByRole('button', { name: character.appearance, exact: true }).click();
    const defaultWearable = saved.wearables.find((item) => item.wearable_key === body.defaults[wearable.slot])!;
    await dialog.getByRole('group', { name: appearance.slots[wearable.slot], exact: true }).getByRole('radio', { name: appearance.defaultOption.replace('{name}', defaultWearable.name), exact: true }).check();
    await dialog.getByRole('button', { name: appearance.save, exact: true }).click();
    await expect(dialog.getByText(appearance.saved, { exact: true })).toBeVisible();
    await closeAppearance(page);
    await expect(message).toHaveValue('换装期间保留的家庭留言草稿');
    expect(await messageNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await taskNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(reads).toEqual([]);
    await expect(preview).toHaveAttribute('data-appearance-version', String(saved.version + 1));
    await expect(preview).toHaveAttribute('data-character-status', 'ready');
    await message.fill('');
    await testInfo.attach('home-3d-character', { body: await panel.screenshot(), contentType: 'image/png' });
  } finally {
    const current = await shopAPI<Appearance>(page, '/appearance');
    await shopAPI(page, '/appearance', 'PUT', { ...appearanceRequest(original), expected_version: current.version });
    await clearFunding(page, funding);
  }
});

// 称号只更新独立装备关系，不改人物四槽、账户版本或任务草稿。
test('真实称号购买后独立佩戴与卸下且不改三维外观版本', async ({ page }, testInfo) => {
  await loginMain(page);
  const original = await shopAPI<Camp>(page, '/camp');
  const before = await shopAPI<Appearance>(page, '/appearance');
  let product: Product | null = null;
  let funding: Funding | null = null;
  try {
    await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
    const assets = await shopAPI<components['schemas']['AssetList']>(page, '/assets');
    product = await shopAPI<Product>(page, '/management/products', 'POST', { type: 'title', name: `三维独立称号-${testInfo.project.name}`, asset_key: assets.items.find((item) => item.kind === 'title')!.key, description: '', coin_price: 0, diamond_price: 0, stock: null, enabled: true });
    await shopAPI(page, '/management/lock', 'POST');
    funding = await fundPurchase(page, product, `称号购买准备-${testInfo.project.name}`);
    await selectShopCategory(page, 'appearance', shop.types.title);
    await purchaseProduct(page, product);
    expect((await shopAPI<Camp>(page, '/camp')).equipment.title).toEqual(original.equipment.title);
    await goHome(page);
    const panel = page.getByRole('region', { name: character.label, exact: true });
    await panel.getByRole('button', { name: character.title, exact: true }).click();
    const picker = page.getByRole('dialog', { name: titles.title, exact: true });
    await picker.getByRole('button', { name: `${titles.equip} ${product.name}`, exact: true }).click();
    await expect(picker.getByRole('button', { name: `${titles.unequip} ${product.name}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByText(product.name, { exact: true })).toBeVisible();
    await picker.getByRole('button', { name: `${titles.unequip} ${product.name}`, exact: true }).click();
    await expect(picker.getByRole('button', { name: `${titles.equip} ${product.name}`, exact: true })).toHaveAttribute('aria-pressed', 'false');
    await picker.getByRole('button', { name: content.common.close, exact: true }).click();
    expect(appearanceRequest(await shopAPI<Appearance>(page, '/appearance'))).toEqual(appearanceRequest(before));
    const after = await shopAPI<Camp>(page, '/camp');
    expect(after.equipment.title).toBeNull();
    expect(after.account.version).toBe(original.account.version);
    expect((await shopAPI<components['schemas']['SessionResponse']>(page, '/session')).management_expires_at).toBeNull();
  } finally {
    await shopAPI(page, '/equipment/title', 'PUT', { purchase_id: original.equipment.title?.id ?? null });
    await clearFunding(page, funding);
    if (product) {
      await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
      await shopAPI(page, `/management/products/${product.id}`, 'DELETE', { expected_version: product.version });
      await shopAPI(page, '/management/lock', 'POST');
    }
  }
});

// 新购家具从实际订单进入完整库存，浏览相机和进出全屏不进入保存数据。
test('主入口真实购买家具后库存摆放保存刷新并返回来源背包', async ({ page }, testInfo) => {
  await loginMain(page);
  const original = await readSpatial(page);
  let funding: Funding | null = null;
  try {
    const definition = original.catalog.find((item) => item.item_key === 'camp-dining-chair-v1')!;
    const product = (await shopAPI<components['schemas']['ProductList']>(page, '/products?type=island')).items.find((item) => item.island_item_key === definition.item_key)!;
    funding = await fundPurchase(page, product, `家具购买准备-${testInfo.project.name}`);
    await selectShopCategory(page, 'island');
    await purchaseProduct(page, product);
    const inventory = await readSpatial(page);
    const owned = inventory.inventory.find((item) => item.item_key === definition.item_key && !original.inventory.some((old) => old.instance_id === item.instance_id))!;
    expect(inventory.version).toBe(original.version);
    await openBackpack(page);
    await page.getByRole('button', { name: shop.goToIsland, exact: true }).click();
    const island = page.getByRole('main', { name: spatial.title, exact: true });
    await expect(island).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/island-immersive/);
    expect(await island.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(22);
    const titleSize = await island.getByRole('heading', { name: spatial.title, exact: true }).evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(titleSize).toBeGreaterThanOrEqual(32);
    expect(titleSize).toBeLessThanOrEqual(40);
    for (const button of await island.getByRole('button').all()) {
      if (!await button.isVisible()) continue;
      const bounds = await button.boundingBox();
      const label = await button.getAttribute('aria-label') ?? await button.innerText();
      expect(bounds!.width, `${label} width`).toBeGreaterThanOrEqual(56);
      expect(bounds!.height, `${label} height`).toBeGreaterThanOrEqual(56);
    }

    await island.getByRole('button', { name: spatial.edit, exact: true }).click();
    const panel = island.getByRole('complementary', { name: spatial.inventory, exact: true });
    await panel.getByRole('button', { name: spatial.indoorItems, exact: true }).click();
    const expand = panel.getByRole('button', { name: spatial.showInventory, exact: true });
    if (await expand.isVisible()) await expand.click();
    const number = inventory.inventory.filter((item) => item.item_key === definition.item_key).findIndex((item) => item.instance_id === owned.instance_id) + 1;
    const name = number === 1 ? definition.name : spatial.additionalInstance.replace('{name}', definition.name).replace('{number}', String(number));
    await panel.getByRole('button', { name: spatial.add.replace('{name}', name), exact: true }).click();
    await island.getByRole('button', { name: spatial.save, exact: true }).click();
    await expect(island.getByText(spatial.saved, { exact: true })).toBeVisible();
    const saved = await readSpatial(page);
    expect(saved.version).toBe(original.version + 1);
    expect(saved.placements.some((item) => item.instance_id === owned.instance_id && item.space === 'indoor')).toBe(true);
    await island.getByRole('button', { name: spatial.back, exact: true }).click();
    await expect(page.getByRole('heading', { name: shop.backpack, exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/island-immersive/);
    await page.reload();
    await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
    expect(spatialRequest(await readSpatial(page))).toEqual(spatialRequest(saved));
    await expect(island.getByRole('region', { name: spatial.scene, exact: true }).locator('canvas')).toBeVisible();
    await testInfo.attach('integrated-island-3d', { body: await island.screenshot(), contentType: 'image/png' });
  } finally {
    const current = await readSpatial(page);
    await shopAPI(page, '/island/layout', 'PUT', { ...spatialRequest(original), expected_version: current.version });
    await clearFunding(page, funding);
  }
});

// 离开失败由实际外部写入造成409，不能导航离开或静默丢掉尚未保存的位置。
test('全屏营地离开时版本冲突保留草稿且取消后可以干净返回', async ({ page }) => {
  await loginMain(page);
  const original = await readSpatial(page);
  try {
    await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
    await page.getByRole('button', { name: spatial.edit, exact: true }).click();
    const house = original.catalog.find((item) => item.assembly === 'house')!;
    await page.getByRole('button', { name: spatial.select.replace('{name}', house.name), exact: true }).click();
    await page.getByRole('button', { name: spatial.moveRight, exact: true }).click();
    await shopAPI(page, '/island/layout', 'PUT', spatialRequest(original));
    await page.getByRole('button', { name: spatial.shop, exact: true }).click();
    const leave = page.getByRole('dialog', { name: spatial.leaveTitle, exact: true });
    await leave.getByRole('button', { name: spatial.saveLeave, exact: true }).click();
    await expect(page.getByText(spatial.conflict, { exact: true })).toBeVisible();
    await expect(leave).toBeVisible();
    await leave.getByRole('button', { name: spatial.stay, exact: true }).click();
    await page.getByRole('button', { name: spatial.cancel, exact: true }).click();
    await page.getByRole('button', { name: spatial.back, exact: true }).click();
    await expect(page.getByRole('heading', { name: checkin.todayTasks, exact: true })).toBeVisible();
    await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
    await page.getByRole('button', { name: spatial.edit, exact: true }).click();
    await page.getByRole('button', { name: spatial.back, exact: true }).click();
    await expect(page.getByRole('dialog', { name: spatial.leaveTitle, exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: checkin.todayTasks, exact: true })).toBeVisible();
  } finally {
    const current = await readSpatial(page);
    await shopAPI(page, '/island/layout', 'PUT', { ...spatialRequest(original), expected_version: current.version });
  }
});

// 实际PUT提交后断回执，关闭重开只读取事实，不再提交一次称号写入。
test('称号未知保存关闭重开后读取真实佩戴事实且PUT仅一次', async ({ page }, testInfo) => {
  await loginMain(page);
  const original = await shopAPI<Camp>(page, '/camp');
  let product: Product | null = null;
  let funding: Funding | null = null;
  try {
    await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
    const assets = await shopAPI<components['schemas']['AssetList']>(page, '/assets');
    product = await shopAPI<Product>(page, '/management/products', 'POST', { type: 'title', name: `未知恢复称号-${testInfo.project.name}`, asset_key: assets.items.find((item) => item.kind === 'title')!.key, description: '', coin_price: 0, diamond_price: 0, stock: null, enabled: true });
    await shopAPI(page, '/management/lock', 'POST');
    funding = await fundPurchase(page, product, `称号恢复准备-${testInfo.project.name}`);
    await selectShopCategory(page, 'appearance', shop.types.title);
    await purchaseProduct(page, product);
    await goHome(page);
    const opener = page.getByRole('region', { name: character.label, exact: true }).getByRole('button', { name: character.title, exact: true });
    await opener.click();
    const picker = page.getByRole('dialog', { name: titles.title, exact: true });
    let writes = 0;
    await page.route('**/api/v1/equipment/title', async (route) => {
      if (route.request().method() === 'PUT') {
        writes++;
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    await picker.getByRole('button', { name: `${titles.equip} ${product.name}`, exact: true }).click();
    await expect(picker.getByText(titles.unknown, { exact: true })).toBeVisible();
    await picker.getByRole('button', { name: content.common.close, exact: true }).click();
    await expect(picker).toHaveCount(0);
    const factRead = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/camp' && response.request().method() === 'GET' && response.ok());
    await opener.click();
    await factRead;
    await expect(picker.getByRole('button', { name: `${titles.unequip} ${product.name}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(picker.getByText(titles.unknown, { exact: true })).toHaveCount(0);
    expect((await shopAPI<Camp>(page, '/camp')).equipment.title?.product_id).toBe(product.id);
    expect(writes).toBe(1);
  } finally {
    await page.unroute('**/api/v1/equipment/title');
    await shopAPI(page, '/equipment/title', 'PUT', { purchase_id: original.equipment.title?.id ?? null });
    await clearFunding(page, funding);
    if (product) {
      await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
      await shopAPI(page, `/management/products/${product.id}`, 'DELETE', { expected_version: product.version });
      await shopAPI(page, '/management/lock', 'POST');
    }
  }
});
