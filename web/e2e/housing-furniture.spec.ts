import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import { openBackpack } from './shop-navigation';
import island from '../src/features/island/content.json' with { type: 'json' };
import catalog from '../../internal/island/catalog.json' with { type: 'json' };
import { canPlace, findPath, interactionPoint } from '../src/features/island/island-geometry';
import type { components } from '../src/api/schema';
import type { IslandDefinition } from '../src/features/island/island-types';
import { familyFurniturePositions, familyHomePlacements } from './housing-furniture-fixtures';

type State = components['schemas']['IslandState'];
type Camp = components['schemas']['CampResponse'];
type Product = components['schemas']['Product'];

// 写请求复用浏览器会话，Origin取当前测试站点，允许隔离端口运行。
async function api<T>(page: Page, path: string, method = 'GET', data?: unknown): Promise<T> {
  const session = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  const response = await page.request.fetch(`/api/v1${path}`, {
    method, data,
    headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.status() === 204 ? undefined as T : response.json() as Promise<T>;
}

// 只接受真实可见的家具表面；透明画布、选择环、地面阴影与前方邻居不算命中。
async function furnitureSurface(placement: Locator): Promise<{ x: number; y: number } | null> {
  return placement.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const pitches = [10, 8, 12, 6, 14, 4, 16, 2, 18];
    const isSurface = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit?.closest('[data-placement-id]') === element && hit.closest('[data-furniture-model]') && hit.tagName.toLowerCase() !== 'ellipse';
    };
    for (const row of pitches) for (const column of pitches) {
      const point = { x: Math.round(bounds.x + bounds.width * column / 20), y: Math.round(bounds.y + bounds.height * row / 20) };
      // WebKit会舍入输入坐标，因此选有内侧余量的表面，不把一像素描边当作可点面积。
      if ([[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]].every(([dx, dy]) => isSurface(point.x + dx!, point.y + dy!))) return point;
    }
    return null;
  });
}

// 完整房屋必须落在实际浮层之外，选中后的紧凑工具栏也纳入测量。
async function expectHouseUnobscured(page: Page) {
  await expect.poll(async () => page.evaluate(() => {
    const house = document.querySelector('.island-scene .island-house-art')!.getBoundingClientRect();
    const header = document.querySelector('.island-page-header')!.getBoundingClientRect();
    const controls = document.querySelector('.island-view-controls')!.getBoundingClientRect();
    const dock = document.querySelector('.island-edit-bar')!.getBoundingClientRect();
    const panel = document.querySelector('#island-inventory-panel')?.getBoundingClientRect();
    const right = panel && panel.width < innerWidth * .8 ? panel.left : innerWidth;
    const bottom = panel && panel.width >= innerWidth * .8 ? Math.min(panel.top, dock.top) : dock.top;
    return house.top >= Math.max(header.bottom, controls.bottom) + 10 && house.bottom <= bottom - 10 && house.left >= -1 && house.right <= right + 1;
  }), { message: '房屋的实际绘图边界应避开顶部操作、缩放按钮、库存与底部工具栏' }).toBe(true);
}

// 几何验收不依赖服务端是否允许旧家具重叠；每件都必须通过实际前端布置规则。
test('完整家庭家具占地互不冲突且房门、书桌和卫生间可达', () => {
  const inventory = familyFurniturePositions.map((position, index) => ({ id: `furniture:${index}`, item_key: position.item_key }));
  const placements = familyHomePlacements(inventory);
  const definitions = catalog as IslandDefinition[];
  for (const placement of placements) expect(canPlace(placement, placements, definitions), placement.item_key).toBe(true);
  const desk = placements.find((placement) => placement.item_key === 'desk')!;
  const definition = definitions.find((item) => item.key === 'desk')!;
  // 本轮扩建新增的右侧空间必须能容纳完整家具，而不是仅把房屋画宽。
  const bed = placements.find((placement) => placement.item_key === 'bed')!;
  expect(canPlace({ ...bed, x: 4.75, y: 1.25 }, placements, definitions), '床应能摆入扩建后的右侧生活区').toBe(true);
  const entrance = { x: 0, y: 3.5 };
  expect(findPath(entrance, interactionPoint(desk, definition), placements, definitions, 'indoor').length).toBeGreaterThan(0);
  expect(findPath(entrance, { x: 3.5, y: -1.75 }, placements, definitions, 'indoor').length).toBeGreaterThan(0);
});

// 真实购买、摆放、调整、保存及重载覆盖完整链路；截图交由视觉验收检查比例与遮挡。
test('家庭家具可购买布置，透明素材完整且室内保存后保持', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
  const task = await api<components['schemas']['Task']>(page, '/management/tasks', 'POST', {
    category_id: null, name: `家庭家具-${testInfo.project.name}-${Date.now()}`, icon_key: 'book-v1',
    coin_reward: 1000, diamond_reward: 0, daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true,
  });
  const camp = await api<Camp>(page, '/camp');
  await api(page, '/checkins', 'POST', {
    expected_today: camp.today, task_id: task.id, expected_task_version: task.version,
    text: '', photo_media_id: null, audio_media_id: null,
  });
  const initial = await api<State>(page, '/island');
  const { items } = await api<{ items: Product[] }>(page, '/products?limit=100');
  const keys = [...new Set(familyFurniturePositions.map((position) => position.item_key))];
  const products = keys.map((key) => {
    const product = items.find((item) => item.island_item_key === key);
    expect(product, `商店缺少 ${key}`).toBeDefined();
    expect(product!.repeatable).toBe(true);
    return product!;
  });
  const chair = products.find((item) => item.island_item_key === 'dining-chair')!;
  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  for (let index = 0; index < 2; index += 1) {
    await page.getByRole('tab', { name: shop.categoryGroups.island, exact: true }).click();
    await page.getByRole('button', { name: `${shop.buy} ${chair.name}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: shop.categoryGroups.island, exact: true })).toHaveAttribute('aria-selected', 'true');
  }
  for (const product of products.filter((item) => item.id !== chair.id)) {
    const current = await api<Camp>(page, '/camp');
    await api(page, '/purchases', 'POST', {
      product_id: product.id, expected_product_version: product.version, expected_wallet_version: current.wallet.version,
    });
  }
  const owned = await api<State>(page, '/island');
  const fresh = owned.inventory.filter((item) => !initial.inventory.some((before) => before.id === item.id));
  expect(fresh.filter((item) => item.item_key === 'dining-chair')).toHaveLength(2);
  expect(fresh).toHaveLength(13);
  const placements = familyHomePlacements(fresh);
  const addedChair = placements.filter((placement) => placement.item_key === 'dining-chair')[1]!;
  // 先准备其余家具，最后一把椅子通过页面库存真正加入场景。
  await api(page, '/island', 'PUT', { expected_version: owned.version, placements: placements.filter((item) => item.id !== addedChair.id) });
  await openBackpack(page);
  await page.getByRole('button', { name: shop.goToIsland, exact: true }).click();
  await page.getByRole('button', { name: island.edit, exact: true }).click();
  await page.getByRole('button', { name: island.showIndoor, exact: true }).click();
  const scene = page.getByRole('group', { name: island.scene, exact: true });
  await expect(scene.locator('[data-house-open]')).toHaveAttribute('data-house-open', 'true');
  const openInventory = page.getByRole('button', { name: island.openInventory, exact: true });
  if (await openInventory.isVisible()) await openInventory.click();
  await page.locator(`[data-inventory-id="${addedChair.id}"]`).getByRole('button').click();
  const chairArt = scene.locator(`[data-placement-id="${addedChair.id}"]`);
  await expect(chairArt).toBeVisible();
  const beforeMove = await chairArt.getAttribute('transform');
  // 找到一个合法微调方向即可，避免测试依赖自动找空位的扫描顺序。
  for (const name of [island.moveRight, island.moveDown, island.moveLeft, island.moveUp]) {
    await page.getByRole('button', { name, exact: true }).click();
    if (await chairArt.getAttribute('transform') !== beforeMove) break;
  }
  await expect(chairArt).not.toHaveAttribute('transform', beforeMove!);
  await page.getByRole('button', { name: island.save, exact: true }).click();
  await expect(page.getByText(island.saved, { exact: true })).toBeVisible();
  const saved = await api<State>(page, '/island');
  expect(saved.placements.filter((item) => item.zone === 'indoor')).toHaveLength(14);
  await page.reload();
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  expect((await api<State>(page, '/island')).placements).toEqual(saved.placements);

  // 统一样例位置用于跨设备视觉比较，仍经过真实所有权与布局保存接口。
  await api(page, '/island', 'PUT', { expected_version: saved.version, placements });
  await page.reload();
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  await expect(scene.locator('[data-actor-zone]')).toHaveAttribute('data-actor-zone', 'outdoor');
  await page.getByRole('button', { name: island.pause, exact: true }).click();
  await expect(scene.locator('[data-house-open]')).toHaveAttribute('data-house-open', 'false');
  const collapseCheckins = page.getByRole('button', { name: island.collapseCheckins, exact: true });
  if (await collapseCheckins.isVisible()) await collapseCheckins.click();
  await page.getByRole('button', { name: island.resetView, exact: true }).click();
  await mkdir('.local/previews', { recursive: true });
  await page.screenshot({ path: `.local/previews/housing-exterior-${testInfo.project.name}.png` });
  const desk = owned.catalog.find((item) => item.key === 'desk')!;
  await page.locator('.island-activity-buttons').getByRole('button', { name: `${island.activities.read} ${desk.name}`, exact: true }).click();
  await expect(scene.locator('[data-actor-zone]')).toHaveAttribute('data-actor-zone', 'indoor', { timeout: 25_000 });
  await expect(scene.locator('[data-actor-zone]')).toHaveAttribute('data-actor-action', 'read', { timeout: 15_000 });
  await page.getByRole('button', { name: island.pause, exact: true }).click();
  await page.getByRole('button', { name: island.edit, exact: true }).click();
  await page.getByRole('button', { name: island.showIndoor, exact: true }).click();
  for (const placement of placements.filter((item) => item.zone === 'indoor')) {
    await expect(scene.locator(`[data-placement-id="${placement.id}"]`)).toBeVisible();
  }

  await expectHouseUnobscured(page);
  const clickableKeys = new Set(['bed', 'dining-chair', 'dining-table', 'toilet']);
  for (const placement of placements.filter((item) => keys.includes(item.item_key as typeof keys[number]))) {
    const artwork = scene.locator(`[data-placement-id="${placement.id}"]`);
    const surface = await furnitureSurface(artwork);
    expect(surface, `${placement.item_key} 应露出真实可点的非阴影表面`).not.toBeNull();
    if (clickableKeys.has(placement.item_key)) {
      await page.mouse.click(surface!.x, surface!.y);
      await expect(artwork).toHaveAttribute('data-selected', 'true');
      await expect(scene.locator('[data-selected="true"]')).toHaveCount(1);
      await expectHouseUnobscured(page);
    }
  }
  // 取原素材画布的已知透明角，要求点落在场景内且穿透至后方，而不是被家具捕获。
  const transparent = await scene.locator('[data-furniture-model="island-dining-table-v1"]').evaluate((element) => {
    const matrix = (element as SVGGraphicsElement).getScreenCTM()!;
    for (const corner of [[-76, -116], [76, -116], [-76, 36], [76, 36]]) {
      const point = new DOMPoint(corner[0]!, corner[1]!).matrixTransform(matrix);
      const hit = document.elementFromPoint(point.x, point.y);
      if (hit?.closest('.island-scene')) return {
        current: element.closest('[data-placement-id]')!.getAttribute('data-placement-id'),
        target: hit.closest('[data-placement-id]')?.getAttribute('data-placement-id') ?? null,
      };
    }
    return null;
  });
  expect(transparent, '至少一个素材透明角实际露在场景内').not.toBeNull();
  expect(transparent!.target).not.toBe(transparent!.current);

  const sources = products.map((product) => `/api/v1/assets/${encodeURIComponent(product.asset_key!)}`);
  for (const source of sources) {
    const response = await page.request.get(source);
    expect(response.status(), source).toBe(200);
    expect(response.headers()['content-type'], source).toContain('image/svg+xml');
  }
  const edges = await page.evaluate(async (urls) => {
    const results: { source: string; visiblePixels: number; opaqueEdgePixels: number }[] = [];
    for (const source of urls) {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 320;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0, 320, 320);
      const pixels = context.getImageData(0, 0, 320, 320).data;
      let visiblePixels = 0, opaqueEdgePixels = 0;
      for (let y = 0; y < 320; y += 1) for (let x = 0; x < 320; x += 1) {
        if (pixels[(y * 320 + x) * 4 + 3]! > 0) {
          visiblePixels += 1;
          if (x === 0 || y === 0 || x === 319 || y === 319) opaqueEdgePixels += 1;
        }
      }
      results.push({ source, visiblePixels, opaqueEdgePixels });
    }
    return results;
  }, sources);
  for (const edge of edges) {
    expect(edge.visiblePixels, edge.source).toBeGreaterThan(0);
    expect(edge.opaqueEdgePixels, `${edge.source} 笔触或阴影不应碰到裁剪边界`).toBe(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const toggleColors = await page.getByRole('button', { name: island.showOutdoor, exact: true }).evaluate((button) => {
    const style = getComputedStyle(button);
    return { color: style.color, backgroundColor: style.backgroundColor };
  });
  await testInfo.attach('interior-toggle-colors', { body: JSON.stringify(toggleColors), contentType: 'application/json' });
  await mkdir('.local/previews', { recursive: true });
  await page.screenshot({ path: `.local/previews/housing-${testInfo.project.name}.png` });
  await scene.screenshot({ path: `.local/previews/housing-indoor-${testInfo.project.name}.png` });
  expect(errors).toEqual([]);
});
