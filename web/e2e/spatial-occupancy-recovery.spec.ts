import { expect, test } from '@playwright/test';
import type { components } from '../src/api/schema';
import { chooseInventory, chooseScene, expectScene, inventory, openScenes, prepareScenes, readScene, restoreScenes, saveScene, sceneKeys } from './spatial-scenes-fixtures';
import content from '../src/features/island/three/spatial-content.json' with { type: 'json' };

type SaveRequest = components['schemas']['SpatialIslandSave'];

test.use({ actionTimeout: 15_000 });

// 两个实际请求端争用同一实例，UI读取同版本的新库存后仍须保留并修正草稿。
test('真实跨场景占用冲突读取同版本库存后保留草稿并修正保存', async ({ page }) => {
  test.setTimeout(150_000);
  await prepareScenes(page);
  const original = await Promise.all(sceneKeys.map(key => readScene(page, key)));
  const contender = await page.context().newPage();
  await page.bringToFront();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const seaside = original[0]!;
    const owned = seaside.inventory.find(item => seaside.catalog.some(definition => definition.item_key === item.item_key && definition.free && definition.spaces.includes('outdoor') && definition.interaction?.activity === 'read'));
    expect(owned, '初始库存应有能移到室外的免费书桌').toBeDefined();
    const desk = owned!;
    const definition = seaside.catalog.find(item => item.item_key === desk.item_key)!;

    // 先释放真实实例，并为竞争场景保留独立的空布局；finally恢复所有原始布局。
    for (const key of sceneKeys) {
      const state = await readScene(page, key);
      const placements = key === sceneKeys[0] ? state.placements.filter(item => item.instance_id !== desk.instance_id) : [];
      if (placements.length !== state.placements.length) await saveScene(page, state, placements);
    }
    await openScenes(page);
    await chooseScene(page, sceneKeys[1]);
    await expectScene(page, sceneKeys[1]);
    const forestBefore = await readScene(page, sceneKeys[1]);
    const environment = forestBefore.environment_key === 'day' ? 'dusk' : 'day';
    const writes: SaveRequest[] = [];
    page.on('request', request => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v1/island/layout') writes.push(request.postDataJSON() as SaveRequest);
    });
    await page.getByRole('button', { name: content.edit, exact: true }).click();
    await chooseInventory(page, definition.name);
    let panel = await inventory(page);
    // 窄屏展开列表时只隐藏微调区，仍按该语义区域核对草稿数据。
    const selection = panel.getByRole('region', { name: definition.name, exact: true, includeHidden: true });
    const draftPosition = await selection.locator('span').innerText();
    await panel.getByRole('combobox', { name: content.environment, exact: true }).selectOption(environment);

    // 同Cookie的独立API端在湖畔真实提交，森林版本保持不变，主页面库存因此过期。
    const lakeBefore = await readScene(contender, sceneKeys[2]);
    const lakePlacement = await page.evaluate(async ({ state, instanceId }) => {
      const modulePath = '/src/features/island/three/spatial-layout.ts';
      const { firstAvailablePlacement } = await import(modulePath);
      const item = state.inventory.find(entry => entry.instance_id === instanceId)!;
      return firstAvailablePlacement(state, state.placements, item, 'outdoor');
    }, { state: lakeBefore, instanceId: desk.instance_id });
    expect(lakePlacement, '实际湖畔几何应有可摆放书桌的位置').not.toBeNull();
    const lakeSaved = await saveScene(contender, lakeBefore, [lakePlacement!]);
    expect(lakeSaved.placements.map(item => item.instance_id)).toEqual([desk.instance_id]);

    const rejectedResponse = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/v1/island/layout');
    await panel.getByRole('button', { name: content.save, exact: true }).click();
    const rejected = await rejectedResponse;
    expect(rejected.status()).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'INVALID_REQUEST', field_errors: { placements: 'PLACED_IN_OTHER_SCENE' } });
    await expect(page.getByText(content.inventoryConflict, { exact: true })).toBeVisible();
    await expect(page.getByText(content.conflict, { exact: true })).toBeHidden();
    await expect(panel.getByRole('button', { name: content.save, exact: true })).toBeDisabled();
    expect((await readScene(contender, sceneKeys[1])).version).toBe(forestBefore.version);
    expect((await readScene(contender, sceneKeys[1])).placements).toEqual([]);

    // 显式读取可以更新跨场景占用；它既不推进森林版本，也不自动重发原保存。
    const refreshedResponse = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).searchParams.get('scene_key') === sceneKeys[1] && new URL(response.url()).pathname === '/api/v1/island/layout');
    await page.getByRole('button', { name: content.readInventory, exact: true }).click();
    const refreshed = await (await refreshedResponse).json() as components['schemas']['SpatialIslandState'];
    expect(refreshed.version).toBe(forestBefore.version);
    expect(refreshed.inventory.find(item => item.instance_id === desk.instance_id)?.placed_scene_key).toBe(sceneKeys[2]);
    await expect(page.getByText(content.review, { exact: true })).toBeVisible();
    panel = await inventory(page);
    await expect(selection.locator('span')).toHaveText(draftPosition);
    await expect(panel.getByRole('combobox', { name: content.environment, exact: true })).toHaveValue(environment);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.expected_version).toBe(forestBefore.version);

    // 已在草稿中的冲突项必须仍可选中收起；移动和旋转不再允许。
    await chooseInventory(page, definition.name, true);
    await expect(page.getByRole('button', { name: content.moveRight, exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: content.rotate, exact: true })).toBeDisabled();
    await page.getByRole('button', { name: content.store, exact: true }).click();
    await page.getByRole('button', { name: content.confirmReview, exact: true }).click();
    panel = await inventory(page);
    await expect(panel.getByRole('combobox', { name: content.environment, exact: true })).toHaveValue(environment);
    await expect(panel.getByRole('button', { name: content.save, exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: content.save, exact: true }).click();
    await expect(page.getByText(content.saved, { exact: true })).toBeVisible();

    const final = await Promise.all(sceneKeys.map(key => readScene(contender, key)));
    const forest = final[1]!, lake = final[2]!;
    expect(forest.version).toBe(forestBefore.version + 1);
    expect(forest.environment_key).toBe(environment);
    expect(forest.placements).toEqual([]);
    expect(lake.version).toBe(lakeSaved.version);
    expect(lake.placements).toEqual(lakeSaved.placements);
    expect(final.flatMap(state => state.placements).filter(item => item.instance_id === desk.instance_id)).toHaveLength(1);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ scene_key: sceneKeys[1], expected_version: forestBefore.version, environment_key: environment, placements: [] });
    expect(errors).toEqual([]);
  } finally {
    try { await restoreScenes(page, original); }
    finally { await contender.close(); }
  }
});
