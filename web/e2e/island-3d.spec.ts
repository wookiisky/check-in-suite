import { expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/features/island/three/spatial-content.json' with { type: 'json' };
import { appearanceAPI } from './appearance-flow-fixtures';
import { test, openIsland3D, readSpatial, selectHouse, spatialRequest, setSpatialCameraOpen } from './island-3d-fixtures';
import { clearFunding, fundPurchase, shopAPI } from './shop-navigation';

test.setTimeout(90_000);
test.use({ actionTimeout: 15_000 });

// 截图前等待真实房屋构件请求结束，再让浏览器完成后续绘制帧。
async function renderFrames(page: Page) {
  await expect(page.getByRole('region', { name: content.scene, exact: true })).toHaveAttribute('data-character-status', 'ready');
  await page.waitForFunction(() => {
    const entries = performance.getEntriesByType('resource');
    return ['camp-wall-v1', 'camp-floor-v1', 'character-medium-v1'].every((key) => entries.some((entry) => entry.name.includes(`/api/v1/assets/${key}`)));
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }));
  await expect(page.getByText(content.sceneError, { exact: true })).toBeHidden();
}

// 独立 PNG 保留在测试产物中，同时附在报告里供人工检查真实 Canvas。
async function captureCanvas(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.getByRole('region', { name: content.scene, exact: true }).locator('canvas').screenshot({ path, style: '.spatial-island > :not(.spatial-stage) { visibility: hidden !important; }' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
  const pagePath = testInfo.outputPath(`${name}-page.png`);
  await page.screenshot({ path: pagePath, fullPage: true });
  await testInfo.attach(`${name}-page`, { path: pagePath, contentType: 'image/png' });
}

// 四向视角和室内展示属于查看状态，实际服务端布局不应改变。
test('桌面和手机真实场景支持四向相机及角色进出屋', async ({ page, originalLayout }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await openIsland3D(page);
  await renderFrames(page);
  await setSpatialCameraOpen(page, true);
  const camera = page.getByRole('navigation', { name: content.camera, exact: true });
  const scene = page.getByRole('region', { name: content.scene, exact: true });
  for (const [index, direction] of content.directions.entries()) {
    await expect(camera.getByText(direction, { exact: true })).toBeVisible();
    await expect(scene).toHaveAttribute('data-camera-direction', String(index));
    await camera.getByRole('button', { name: content.cameraRight, exact: true }).click();
  }
  await camera.getByRole('button', { name: content.zoomIn, exact: true }).click();
  await camera.getByRole('button', { name: content.zoomOut, exact: true }).click();
  await camera.getByRole('button', { name: content.resetCamera, exact: true }).click();
  await setSpatialCameraOpen(page, false);
  await captureCanvas(page, testInfo, 'outdoor-canvas');
  await page.getByRole('button', { name: content.enter, exact: true }).click();
  await expect(page.getByRole('button', { name: content.exit, exact: true })).toBeVisible({ timeout: 40_000 });
  await expect(scene).toHaveAttribute('data-actor-space', 'indoor');
  await expect(page.getByRole('button', { name: content.outdoor, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await captureCanvas(page, testInfo, 'indoor-canvas');
  await page.getByRole('button', { name: content.exit, exact: true }).click();
  await expect(page.getByRole('button', { name: content.enter, exact: true })).toBeVisible({ timeout: 40_000 });
  await expect(scene).toHaveAttribute('data-actor-space', 'outdoor');
  const current = await readSpatial(page);
  expect(spatialRequest(current)).toEqual(spatialRequest(originalLayout));
  expect(errors).toEqual([]);
});

// 默认无关联任务的阅读使用真实书桌和手部道具，完成走位后检查实际 Canvas。
test('真实阅读走到书桌表演并显示手部书本道具', async ({ page, originalLayout }, testInfo) => {
  expect(originalLayout.catalog.some((item) => item.interaction?.activity === 'read')).toBe(true);
  await openIsland3D(page);
  await renderFrames(page);
  await page.getByRole('button', { name: content.activities.read, exact: true }).click();
  const scene = page.getByRole('region', { name: content.scene, exact: true });
  await expect(scene).toHaveAttribute('data-actor-phase', 'performing', { timeout: 40_000 });
  await expect(page.getByText(`${content.activities.read} · ${content.phases.performing}`, { exact: true })).toBeVisible();
  await expect(scene).toHaveAttribute('data-actor-space', 'indoor');
  await renderFrames(page);
  await setSpatialCameraOpen(page, true);
  await page.getByRole('button', { name: content.resetCamera, exact: true }).click();
  for (let step = 0; step < 3; step++) await page.getByRole('button', { name: content.zoomIn, exact: true }).click();
  await setSpatialCameraOpen(page, false);
  await captureCanvas(page, testInfo, 'reading-front-canvas');
  await setSpatialCameraOpen(page, true);
  await page.getByRole('button', { name: content.cameraRight, exact: true }).click();
  await setSpatialCameraOpen(page, false);
  await captureCanvas(page, testInfo, 'reading-turned-canvas');
  expect(spatialRequest(await readSpatial(page))).toEqual(spatialRequest(originalLayout));
});

// 在实际营地中使用目录绑定播放踢球，暂停时保留当前活动。
test('真实营地按目录绑定踢球并可暂停恢复', async ({ page, originalLayout }) => {
  const binding = originalLayout.scene.activity_presentations.ball!;
  expect(binding.ball?.contact_seconds).toBeGreaterThan(0);
  const ball = originalLayout.catalog.find((item) => item.interaction?.activity === 'ball')!;
  let owned = originalLayout.inventory.find((item) => item.item_key === ball.item_key);
  if (!owned) {
    const { items } = await shopAPI<components['schemas']['ProductList']>(page, '/products?type=island');
    const product = items.find((item) => item.island_item_key === ball.item_key)!;
    const funding = await fundPurchase(page, product, '踢球验证余额');
    try {
      const { wallet } = await shopAPI<components['schemas']['CampResponse']>(page, '/camp');
      await shopAPI(page, '/purchases', 'POST', { product_id: product.id, expected_product_version: product.version, expected_wallet_version: wallet.version });
    } finally {
      await clearFunding(page, funding);
    }
    owned = (await readSpatial(page)).inventory.find((item) => item.item_key === ball.item_key);
  }
  const layout = await shopAPI<typeof originalLayout>(page, '/island/layout', 'PUT', {
    ...spatialRequest(originalLayout),
    placements: [...originalLayout.placements, { instance_id: owned!.instance_id, item_key: ball.item_key, space: 'outdoor', x_cm: 650, z_cm: 0, rotation: 0 }],
  } satisfies components['schemas']['SpatialIslandSave']);
  await openIsland3D(page);
  await renderFrames(page);
  const scene = page.getByRole('region', { name: content.scene, exact: true });
  await page.getByRole('button', { name: content.activities.ball, exact: true }).click();
  await expect(scene).toHaveAttribute('data-actor-phase', 'performing', { timeout: 40_000 });
  await expect(page.getByText(`${content.activities.ball} · ${content.phases.performing}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: content.pause, exact: true }).click();
  await expect(page.getByText(content.paused, { exact: true })).toBeVisible();
  await expect(scene).toHaveAttribute('data-actor-phase', 'performing');
  await page.getByRole('button', { name: content.resume, exact: true }).click();
  await expect(page.getByText(`${content.activities.ball} · ${content.phases.performing}`, { exact: true })).toBeVisible();
  await expect(page.getByText(content.sceneError, { exact: true })).toBeHidden();
  expect(spatialRequest(await readSpatial(page))).toEqual(spatialRequest(layout));
});

// 微调、环境和完整布局由同一 PUT 保存；刷新和取消分别核实已保存值与版本。
test('移动主屋保存后刷新持久化且取消不写入', async ({ page, originalLayout }, testInfo) => {
  await openIsland3D(page);
  const house = originalLayout.placements.find((item) => originalLayout.catalog.find((definition) => definition.item_key === item.item_key)?.assembly === 'house')!;
  const selected = await selectHouse(page, originalLayout);
  await page.getByRole('button', { name: content.moveRight, exact: true }).click();
  await expect(selected).toContainText(`${content.position} ${house.x_cm + 10}, ${house.z_cm}`);
  await renderFrames(page);
  await captureCanvas(page, testInfo, 'editing-canvas');
  const environment = originalLayout.scene.environments.find((key) => key !== originalLayout.environment_key)!;
  const showInventory = page.getByRole('button', { name: content.showInventory, exact: true });
  if (await showInventory.isVisible()) await showInventory.click();
  await page.getByRole('complementary', { name: content.inventory, exact: true }).locator('.spatial-environment select').selectOption(environment);
  await page.getByRole('button', { name: content.save, exact: true }).click();
  await expect(page.getByText(content.saved, { exact: true })).toBeVisible();
  const saved = await readSpatial(page);
  expect(saved.version).toBe(originalLayout.version + 1);
  expect(saved.environment_key).toBe(environment);
  expect(saved.placements.find((item) => item.instance_id === house.instance_id)).toEqual({ ...house, x_cm: house.x_cm + 10 });
  await page.reload();
  await expect(page.getByRole('button', { name: content.edit, exact: true })).toBeEnabled();
  const refreshed = await selectHouse(page, saved);
  await expect(refreshed).toContainText(`${content.position} ${house.x_cm + 10}, ${house.z_cm}`);
  await page.getByRole('button', { name: content.moveRight, exact: true }).click();
  await expect(refreshed).toContainText(`${content.position} ${house.x_cm + 20}, ${house.z_cm}`);
  await page.getByRole('button', { name: content.cancel, exact: true }).click();
  expect(spatialRequest(await readSpatial(page))).toEqual(spatialRequest(saved));
});

// 外部真实写入制造 409，草稿必须在读取最新版本及人工核对后仍然存在。
test('布局版本冲突保留位置草稿并按核对后的版本保存', async ({ page, originalLayout }) => {
  await openIsland3D(page);
  const house = originalLayout.placements.find((item) => originalLayout.catalog.find((definition) => definition.item_key === item.item_key)?.assembly === 'house')!;
  const selected = await selectHouse(page, originalLayout);
  await page.getByRole('button', { name: content.moveRight, exact: true }).click();
  const position = `${content.position} ${house.x_cm + 10}, ${house.z_cm}`;
  expect((await appearanceAPI(page, '/island/layout', 'PUT', spatialRequest(originalLayout))).ok()).toBe(true);
  const conflict = page.waitForResponse((response) => response.url().endsWith('/api/v1/island/layout') && response.status() === 409);
  await page.getByRole('button', { name: content.save, exact: true }).click();
  await conflict;
  await expect(page.getByText(content.conflict, { exact: true })).toBeVisible();
  await expect(selected).toContainText(position);
  await expect(page.getByRole('button', { name: content.save, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: content.readLatest, exact: true }).click();
  await expect(page.getByText(content.review, { exact: true })).toBeVisible();
  await expect(selected).toContainText(position);
  await page.getByRole('button', { name: content.confirmReview, exact: true }).click();
  await page.getByRole('button', { name: content.save, exact: true }).click();
  await expect(page.getByText(content.saved, { exact: true })).toBeVisible();
  const saved = await readSpatial(page);
  expect(saved.version).toBe(originalLayout.version + 2);
  expect(saved.placements.find((item) => item.instance_id === house.instance_id)?.x_cm).toBe(house.x_cm + 10);
});

// 路由先转发并确认真实事务提交，再断开响应；读回不能重发导致版本再增加。
test('PUT 已提交但响应丢失后读回确认且版本仅增加一次', async ({ page, originalLayout }) => {
  await openIsland3D(page);
  await selectHouse(page, originalLayout);
  await page.getByRole('button', { name: content.moveRight, exact: true }).click();
  let writes = 0;
  await page.route('**/api/v1/island/layout', async (route) => {
    if (route.request().method() === 'PUT') {
      writes++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: content.save, exact: true }).click();
  await expect(page.getByText(content.unknownSave, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: content.cancel, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: content.moveRight, exact: true })).toBeDisabled();
  expect((await readSpatial(page)).version).toBe(originalLayout.version + 1);
  await page.getByRole('button', { name: content.readResult, exact: true }).click();
  await expect(page.getByText(content.unknownSave, { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: content.edit, exact: true })).toBeEnabled();
  expect((await readSpatial(page)).version).toBe(originalLayout.version + 1);
  expect(writes).toBe(1);
});

// 模型读取失败不能吞掉 HTML 控件，重试需重新请求真实 GLB 并恢复 Canvas。
test('场景模型失败后保留 HTML 控件并可重试加载真实资源', async ({ page, originalLayout }, testInfo) => {
  const modelURL = originalLayout.catalog.find((item) => item.interaction?.activity === 'read')!.model_url!;
  const pattern = `**${modelURL}`;
  let failures = 0;
  await page.route(pattern, async (route) => {
    failures++;
    await route.fulfill({ status: 503, contentType: 'text/plain', body: 'e2e model unavailable' });
  });
  await openIsland3D(page);
  await page.getByRole('button', { name: content.indoor, exact: true }).click();
  await expect(page.getByText(content.sceneError, { exact: true })).toBeVisible();
  expect(failures).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: content.back, exact: true })).toBeVisible();
  await page.unroute(pattern);
  const loaded = page.waitForResponse((response) => response.url().endsWith(modelURL) && response.ok());
  await page.getByRole('button', { name: content.assetRetry, exact: true }).click();
  await loaded;
  await expect(page.getByText(content.sceneError, { exact: true })).toBeHidden();
  await renderFrames(page);
  await captureCanvas(page, testInfo, 'recovered-canvas');
  expect(spatialRequest(await readSpatial(page))).toEqual(spatialRequest(originalLayout));
});

// 手部道具在阅读开始时才读取，失败后必须保留普通 HTML 重试并重新准备人物。
test('阅读书本加载失败后通过 HTML 重试恢复真实活动', async ({ page, originalLayout }) => {
  const modelURL = originalLayout.scene.activity_presentations.read!.attachment!.model_url;
  const pattern = `**${modelURL}`;
  await openIsland3D(page);
  await renderFrames(page);
  let failures = 0;
  await page.route(pattern, async (route) => {
    failures++;
    await route.fulfill({ status: 503, contentType: 'text/plain', body: 'e2e attachment unavailable' });
  });
  await page.getByRole('button', { name: content.activities.read, exact: true }).click();
  await expect(page.getByText(content.sceneError, { exact: true })).toBeVisible({ timeout: 40_000 });
  expect(failures).toBeGreaterThan(0);
  const scene = page.getByRole('region', { name: content.scene, exact: true });
  await expect(scene).toHaveAttribute('data-character-status', 'error');
  await page.unroute(pattern);
  const loaded = page.waitForResponse((response) => response.url().endsWith(modelURL) && response.ok(), { timeout: 40_000 });
  await page.getByRole('button', { name: content.assetRetry, exact: true }).click();
  await loaded;
  await expect(scene).toHaveAttribute('data-character-status', 'ready');
  await expect(scene).toHaveAttribute('data-actor-phase', 'performing');
  await expect(page.getByText(content.sceneError, { exact: true })).toBeHidden();
  expect(spatialRequest(await readSpatial(page))).toEqual(spatialRequest(originalLayout));
});
