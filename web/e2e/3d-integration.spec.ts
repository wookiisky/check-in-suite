import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import family from '../src/features/family/content.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import appearance from '../src/features/shop/appearance-content.json' with { type: 'json' };
import character from '../src/features/character/character-panel-content.json' with { type: 'json' };
import spatial from '../src/features/island/three/spatial-content.json' with { type: 'json' };
import { appearanceRequest } from './appearance-flow-fixtures';
import { readSpatial, spatialRequest } from './island-3d-fixtures';
import { loginMain, shopAPI, selectShopCategory, purchaseProduct, openAppearance, goHome } from './shop-navigation';

type Product = components['schemas']['Product'];
type Appearance = components['schemas']['AppearanceState'];
type Task = components['schemas']['Task'];
type Checkin = components['schemas']['Checkin'];
type Camp = components['schemas']['CampResponse'];
type Funding = { task: Task; record: Checkin };

test.setTimeout(120_000);
test.use({ actionTimeout: 15_000 });

// 只改颜色也进入正式外观版本，首页和营地都能准备保存后的同一套穿戴。
test('背心换色可放弃，保存后同步首页和营地', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loginMain(page);
  const original = await shopAPI<Appearance>(page, '/appearance');
  try {
    const state = await shopAPI<Appearance>(page, '/appearance', 'PUT', {
      expected_version: original.version, character_key: original.default_character_key,
      face_purchase_id: null, head_purchase_id: null, upper_purchase_id: null,
      lower_purchase_id: null, shoes_purchase_id: null, back_purchase_id: null,
    });
    expect(state.wearable_colors?.map((item) => item.key)).toEqual(['ivory', 'black', 'red', 'orange', 'yellow', 'blue', 'green', 'brown']);
    expect(state.wearables.filter((item) => item.dye_material).map((item) => item.wearable_key).sort()).toEqual([
      'kaykit-adventurers-knight-back-cape', 'kaykit-skeletons-minion-back-cloak', 'upper-human-tank-v1',
    ]);
    const home = page.getByRole('region', { name: character.label, exact: true }).locator('.character3d-preview');
    const stage = page.getByRole('region', { name: spatial.scene, exact: true });
    const islandButton = page.getByRole('navigation', { name: content.navigation.label }).getByRole('button', { name: content.navigation.island, exact: true });
    const leaveIsland = page.getByRole('button', { name: spatial.back, exact: true });
    await openAppearance(page);
    const wardrobe = page.locator('.appearance-page');
    const model = wardrobe.locator('.character3d-preview');
    const color = (name: string) => wardrobe.getByRole('radio', { name, exact: true });
    const upper = wardrobe.getByRole('tab', { name: appearance.slots.upper, exact: true });
    await upper.click();
    await expect(color('米白')).toBeChecked();
    const colorCard = (name: string) => wardrobe.locator('.appearance-color-option').filter({ has: page.getByRole('radio', { name, exact: true }) });
    const ivory = colorCard('米白');
    const name = ivory.getByText('米白', { exact: true });
    const [nameBounds, swatchBounds] = await Promise.all([name.boundingBox(), ivory.locator('.appearance-color-sample').boundingBox()]);
    expect(nameBounds!.y).toBeGreaterThanOrEqual(swatchBounds!.y);
    expect(nameBounds!.y + nameBounds!.height).toBeLessThanOrEqual(swatchBounds!.y + swatchBounds!.height);
    expect(swatchBounds!.width).toBeLessThanOrEqual(44);
    expect(swatchBounds!.height).toBeCloseTo(swatchBounds!.width, 0);
    const cards = await wardrobe.locator('.appearance-color-option').evaluateAll((options) =>
      options.map((option) => ({ top: option.getBoundingClientRect().top, width: option.getBoundingClientRect().width })),
    );
    expect(cards).toHaveLength(8);
    expect(new Set(cards.map((card) => card.top)).size).toBe(1);
    expect(Math.min(...cards.map((card) => card.width))).toBeGreaterThanOrEqual(24);
    const palette = wardrobe.locator('.appearance-colors');
    await palette.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await palette.screenshot({ path: testInfo.outputPath('color-options.png') });
    await expect(model).toHaveAttribute('data-character-status', 'ready');
    const canvas = model.locator('canvas');
    await canvas.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    const base = await canvas.screenshot({ path: testInfo.outputPath('round-neck-ivory.png') });
    await colorCard('黄').locator('.appearance-color-sample').click();
    await expect(color('黄')).toBeChecked();
    await expect(colorCard('黄')).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect(ivory).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect(model).toHaveAttribute('data-character-status', 'ready');
    await canvas.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await expect.poll(async () => (await canvas.screenshot()).equals(base)).toBe(false);
    await goHome(page);
    await page.getByRole('dialog', { name: appearance.discardTitle }).getByRole('button', { name: appearance.discard, exact: true }).click();
    expect(appearanceRequest(await shopAPI<Appearance>(page, '/appearance'))).toEqual(appearanceRequest(state));
    await expect(home).toHaveAttribute('data-character-status', 'ready');
    const homeBefore = await home.locator('canvas').screenshot();
    await islandButton.click();
    await expect(stage).toHaveAttribute('data-character-status', 'ready', { timeout: 20_000 });
    const islandBefore = await stage.locator('canvas').screenshot();
    await leaveIsland.click();

    await openAppearance(page);
    await upper.click();
    await expect(color('米白')).toBeChecked();
    await color('黄').check();
    await wardrobe.getByRole('button', { name: appearance.save, exact: true }).click();
    await expect(wardrobe.getByText(appearance.saved, { exact: true })).toBeVisible();
    const saved = await shopAPI<Appearance>(page, '/appearance');
    expect(saved.version).toBe(state.version + 1);
    expect(saved.upper_purchase_id).toBeNull();
    expect(saved.upper_color_key).toBe('yellow');
    await expect(model).toHaveAttribute('data-character-status', 'ready');
    await model.locator('canvas').screenshot({ path: testInfo.outputPath('round-neck-yellow.png') });
    await goHome(page);
    await expect(home).toHaveAttribute('data-appearance-version', String(saved.version));
    await expect(home).toHaveAttribute('data-character-status', 'ready');
    const homeAfter = await home.locator('canvas').screenshot();
    expect(homeAfter.equals(homeBefore)).toBe(false);
    await testInfo.attach('saved-yellow-vest-home', { body: homeAfter, contentType: 'image/png' });
    await islandButton.click();
    await expect(stage).toHaveAttribute('data-character-status', 'ready', { timeout: 20_000 });
    const islandAfter = await stage.locator('canvas').screenshot();
    expect(islandAfter.equals(islandBefore)).toBe(false);
    await testInfo.attach('saved-yellow-vest-island', { body: islandAfter, contentType: 'image/png' });
    await leaveIsland.click();
    await openAppearance(page);
    await upper.click();
    await expect(color('黄')).toBeChecked();
  } finally {
    const current = await shopAPI<Appearance>(page, '/appearance');
    await shopAPI(page, '/appearance', 'PUT', { ...appearanceRequest(original), expected_version: current.version });
  }
});

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
test('真实购买服装不自动换装，独立装扮页保存后打卡页显示新外观', async ({ page }, testInfo) => {
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
    await openAppearance(page);
    const wardrobe = page.locator('.appearance-page');
    await wardrobe.getByRole('tab', { name: appearance.slots[wearable.slot], exact: true }).click();
    await wardrobe.getByRole('radio', { name: wearable.name, exact: true }).check();
    await wardrobe.getByRole('button', { name: appearance.save, exact: true }).click();
    await expect(wardrobe.getByText(appearance.saved, { exact: true })).toBeVisible();
    const saved = await shopAPI<Appearance>(page, '/appearance');
    expect(saved[`${wearable.slot}_purchase_id`]).toBe(owned.purchase_id);
    await goHome(page);
    const panel = page.getByRole('region', { name: character.label, exact: true });
    const preview = panel.locator('.character3d-preview');
    await expect(preview).toHaveAttribute('data-appearance-version', String(saved.version));
    await expect(preview).toHaveAttribute('data-character-status', 'ready');
    const message = page.getByLabel(family.input, { exact: true });
    await message.fill('换装期间保留的家庭留言草稿');
    const task = page.locator('.checkin-task').filter({ hasText: funding.task.name });
    await expect(task).toBeVisible();
    await openAppearance(page);
    await wardrobe.getByRole('tab', { name: appearance.slots[wearable.slot], exact: true }).click();
    const defaultWearable = saved.wearables.find((item) => item.wearable_key === body.defaults[wearable.slot])!;
    await wardrobe.getByRole('radio', { name: defaultWearable.name, exact: true }).check();
    await wardrobe.getByRole('button', { name: appearance.save, exact: true }).click();
    await expect(wardrobe.getByText(appearance.saved, { exact: true })).toBeVisible();
    await goHome(page);
    await expect(message).toHaveValue('换装期间保留的家庭留言草稿');
    await expect(task).toBeVisible();
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

// 新购家具从实际订单进入完整库存，浏览相机和进出全屏不进入保存数据。
test('主入口真实购买家具后在营地摆放保存并返回商店', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loginMain(page);
  const original = await readSpatial(page);
  let funding: Funding | null = null;
  try {
    // 两个浏览器项目共用测试账户，分别购买可摆入屋内的不同物件。
    const itemKey = testInfo.project.name === 'desktop-chromium' ? 'camp-dining-chair-v1' : 'camp-coffee-table-v1';
    const definition = original.catalog.find((item) => item.item_key === itemKey)!;
    const product = (await shopAPI<components['schemas']['ProductList']>(page, '/products?type=island')).items.find((item) => item.island_item_key === definition.item_key)!;
    funding = await fundPurchase(page, product, `家具购买准备-${testInfo.project.name}`);
    await selectShopCategory(page, 'island');
    await purchaseProduct(page, product);
    const inventory = await readSpatial(page);
    const owned = inventory.inventory.find((item) => item.item_key === definition.item_key && !original.inventory.some((old) => old.instance_id === item.instance_id))!;
    expect(inventory.version).toBe(original.version);
    await page.getByRole('navigation', { name: content.navigation.label }).getByRole('button', { name: content.navigation.island, exact: true }).click();
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
    await expect(page.getByRole('tablist', { name: shop.categoryGroupLabel, exact: true })).toBeVisible();
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
