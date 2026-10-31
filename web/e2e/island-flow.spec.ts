import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import { openBackpack, openWardrobe } from './shop-navigation';
import island from '../src/features/island/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';

type Camp = components['schemas']['CampResponse'];
type Product = components['schemas']['Product'];
type IslandState = components['schemas']['IslandState'];

// 准备数据与持久化断言仍经过当前浏览器的真实会话及写请求保护。
async function api<T>(page: Page, path: string, method = 'GET', data?: unknown): Promise<T> {
  const session = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  const response = await page.request.fetch(`/api/v1${path}`, {
    method, data,
    headers: { Origin: 'http://127.0.0.1:15173', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.status() === 204 ? undefined as T : response.json() as Promise<T>;
}

// 每个浏览器项目独立赚取余额，避免依赖其它端到端用例的顺序。
async function prepareBalance(page: Page, suffix: string) {
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
  const task = await api<components['schemas']['Task']>(page, '/management/tasks', 'POST', {
    category_id: null, name: `小岛测试-${suffix}`, icon_key: 'book-v1', coin_reward: 500, diamond_reward: 20,
    daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true,
  });
  const camp = await api<Camp>(page, '/camp');
  await api(page, '/checkins', 'POST', {
    expected_today: camp.today, task_id: task.id, expected_task_version: task.version,
    text: '', photo_media_id: null, audio_media_id: null,
  });
}

// 同一页面完成购买、摆放和保存；接口只用来准备条件并验证实际结果。
test('二维小岛支持多件购买、视图操作、布置恢复与室内活动', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await prepareBalance(page, testInfo.project.name);
  const initial = await api<IslandState>(page, '/island');
  // 两种浏览器共享测试服务；还原免费布局，保留已经购买的库存。
  await api(page, '/island', 'PUT', {
    expected_version: initial.version,
    placements: [
      { id: 'base:house', item_key: 'house', x: -1.5, y: -2, rotation: 0, zone: 'outdoor' },
      { id: 'base:desk', item_key: 'desk', x: 0, y: 0, rotation: 0, zone: 'indoor' },
      { id: 'base:run', item_key: 'run', x: 3.25, y: 4, rotation: 0, zone: 'outdoor' },
      { id: 'base:environment', item_key: 'day', x: 0, y: 0, rotation: 0, zone: 'outdoor' },
    ],
  });
  const { items } = await api<{ items: Product[] }>(page, '/products');
  const tree = items.find((item) => item.island_item_key === 'tree')!;
  const book = items.find((item) => item.island_item_key === 'book')!;
  const ball = items.find((item) => item.island_item_key === 'ball')!;
  expect(tree.repeatable).toBe(true);
  expect(book.type).toBe('accessory');
  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  for (let count = 0; count < 2; count += 1) {
    await page.getByRole('tab', { name: shop.categoryGroups.island, exact: true }).click();
    await page.getByRole('button', { name: `${shop.buy} ${tree.name}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: shop.categoryGroups.island, exact: true })).toHaveAttribute('aria-selected', 'true');
  }
  const owned = await api<IslandState>(page, '/island');
  const added = owned.inventory.filter((item) => !initial.inventory.some((previous) => previous.id === item.id));
  expect(added.filter((item) => item.item_key === 'tree')).toHaveLength(2);
  if (!owned.inventory.some((item) => item.item_key === 'book')) {
    await page.getByRole('tab', { name: shop.categoryGroups.island, exact: true }).click();
    await page.getByRole('button', { name: `${shop.buy} ${book.name}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.getByRole('tab', { name: shop.categoryGroups.island, exact: true }).click();
  await page.getByRole('button', { name: `${shop.buy} ${ball.name}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: shop.confirmPurchase, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const withBook = await api<IslandState>(page, '/island');
  const ownedBook = withBook.inventory.find((item) => item.item_key === 'book')!;
  const outfit = (await api<Camp>(page, '/camp')).equipment;
  for (const accessory of outfit.accessories) {
    if (accessory.id !== ownedBook.id) await api(page, `/equipment/accessories/${accessory.id}`, 'DELETE');
  }
  await api(page, `/equipment/accessories/${ownedBook.id}`, 'PUT');
  expect((await api<Camp>(page, '/camp')).equipment.accessories.some((item) => item.id === ownedBook.id)).toBe(true);
  await openWardrobe(page);
  await expect(page.getByRole('button', { name: `${shop.unequip} ${book.name}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `${shop.equip} ${ball.name}`, exact: true })).toHaveCount(0);
  await openBackpack(page);
  await page.getByRole('button', { name: shop.goToIsland, exact: true }).click();
  await expect(page.getByRole('heading', { name: island.title, exact: true })).toBeVisible();
  const scene = page.getByRole('group', { name: island.scene, exact: true });
  await expect(scene).toBeVisible();
  // 手机打卡浮层会覆盖场景左侧，先收起面板再验证场景本身的拖动。
  await page.getByRole('button', { name: island.collapseCheckins, exact: true }).click();
  await expect(page.getByRole('button', { name: island.expandCheckins, exact: true })).toBeVisible();
  const defaultZoom = Number(await scene.getAttribute('data-zoom'));
  const defaultPan = Number(await scene.getAttribute('data-pan-x'));
  await page.getByRole('button', { name: island.zoomIn, exact: true }).click();
  await expect.poll(async () => Number(await scene.getAttribute('data-zoom'))).toBeGreaterThan(defaultZoom);
  await page.getByRole('button', { name: island.zoomOut, exact: true }).click();
  await page.getByRole('button', { name: island.resetView, exact: true }).click();
  await expect.poll(async () => Number(await scene.getAttribute('data-zoom'))).toBe(defaultZoom);
  await scene.scrollIntoViewIfNeeded();
  if (!testInfo.project.use.isMobile) {
    await scene.hover();
    const scrollY = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => Number(await scene.getAttribute('data-zoom'))).toBeGreaterThan(defaultZoom);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    await page.getByRole('button', { name: island.resetView, exact: true }).click();
  }
  const bounds = await scene.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + 25, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 65, bounds!.y + bounds!.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Number(await scene.getAttribute('data-pan-x'))).not.toBe(defaultPan);
  await page.getByRole('button', { name: island.resetView, exact: true }).click();
  await scene.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Number(await scene.getAttribute('data-pan-x'))).not.toBe(defaultPan);
  await page.getByRole('button', { name: island.resetView, exact: true }).click();
  await page.getByRole('button', { name: island.edit, exact: true }).click();
  await expect(scene).toHaveAttribute('data-editing', 'true');
  const editZoom = Number(await scene.getAttribute('data-zoom'));
  await page.getByRole('button', { name: island.zoomIn, exact: true }).click();
  await expect.poll(async () => Number(await scene.getAttribute('data-zoom'))).toBeGreaterThan(editZoom);
  await page.getByRole('button', { name: island.resetView, exact: true }).click();
  const firstTree = added[0]!;
  const secondTree = added[1]!;
  await page.locator(`[data-inventory-id="${firstTree.id}"]`).getByRole('button').click();
  const firstTreeArt = scene.locator(`[data-placement-id="${firstTree.id}"]`);
  const initialTransform = await firstTreeArt.getAttribute('transform');
  await page.getByRole('button', { name: island.moveRight, exact: true }).click();
  await expect(firstTreeArt).not.toHaveAttribute('transform', initialTransform!);
  await firstTreeArt.scrollIntoViewIfNeeded();
  const treeBounds = await firstTreeArt.boundingBox();
  expect(treeBounds).not.toBeNull();
  const beforeDrag = await firstTreeArt.getAttribute('transform');
  // 后方树木的包围盒中心可能被屋顶遮住，找到真实露出的树冠再用鼠标拖动。
  const treeHit = await firstTreeArt.evaluate((element) => {
    const box = element.getBoundingClientRect();
    for (const yRatio of [0.2, 0.35, 0.5, 0.65]) for (const xRatio of [0.5, 0.35, 0.65]) {
      const point = { x: box.x + box.width * xRatio, y: box.y + box.height * yRatio };
      if (document.elementFromPoint(point.x, point.y)?.closest('[data-placement-id]') === element) return point;
    }
    return null;
  });
  expect(treeHit, '树冠应有真实可拖动的露出区域').not.toBeNull();
  await page.mouse.move(treeHit!.x, treeHit!.y);
  await page.mouse.down();
  await page.mouse.move(treeHit!.x + 20, treeHit!.y + 15, { steps: 5 });
  await page.mouse.up();
  await expect(firstTreeArt).not.toHaveAttribute('transform', beforeDrag!);
  await page.locator(`[data-inventory-id="${secondTree.id}"]`).getByRole('button').click();
  await page.locator(`[data-inventory-id="${ownedBook.id}"]`).getByRole('button').click();
  await page.getByRole('button', { name: island.save, exact: true }).click();
  await expect(page.getByText(island.saved, { exact: true })).toBeVisible();
  const saved = await api<IslandState>(page, '/island');
  expect(saved.placements.filter((item) => item.item_key === 'tree')).toHaveLength(2);
  expect(saved.placements.some((item) => item.id === ownedBook.id)).toBe(true);
  expect((await api<Camp>(page, '/camp')).equipment.accessories.some((item) => item.id === ownedBook.id)).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  await expect(scene.locator(`[data-placement-id="${firstTree.id}"]`)).toBeVisible();
  expect((await api<IslandState>(page, '/island')).placements).toEqual(saved.placements);

  // 观察真实活动状态，不用固定sleep猜测角色是否已经进屋。
  const desk = saved.catalog.find((item) => item.key === 'desk')!;
  const run = saved.catalog.find((item) => item.key === 'run')!;
  // 点击实际SVG物件经历pointer capture，不能用DOM dispatch或旁边按钮替代。
  await page.getByRole('button', { name: island.pause, exact: true }).click();
  await expect(page.getByRole('button', { name: island.resume, exact: true })).toBeVisible();
  await scene.locator('[data-placement-id="base:run"]').click();
  await expect(page.getByRole('button', { name: island.pause, exact: true })).toBeVisible();
  await expect(scene.locator('[data-actor-zone]')).toHaveAttribute('data-actor-action', 'run', { timeout: 20_000 });
  await page.locator('.island-activity-buttons').getByRole('button', { name: `${island.activities.read} ${desk.name}`, exact: true }).click();
  await expect(scene.locator('[data-actor-zone]')).toHaveAttribute('data-actor-zone', 'indoor', { timeout: 20_000 });
  await expect(scene.locator('[data-house-open]')).toHaveAttribute('data-house-open', 'true');
  await expect(scene.locator('[data-actor-zone]')).toHaveAttribute('data-actor-action', 'read', { timeout: 10_000 });
  await page.getByRole('button', { name: island.pause, exact: true }).click();
  await expect(page.getByRole('button', { name: island.resume, exact: true })).toBeVisible();
  await scene.locator('[data-placement-id="base:desk"]').click();
  await expect(page.getByRole('button', { name: island.pause, exact: true })).toBeVisible();
  await expect(scene.locator('[data-actor-zone]')).toHaveAttribute('data-actor-action', 'read');
  await mkdir('.local/previews', { recursive: true });
  await scene.screenshot({ path: `.local/previews/island-indoor-${testInfo.project.name}.png` });
  await page.locator('.island-activity-buttons').getByRole('button', { name: `${island.activities.run} ${run.name}`, exact: true }).click();
  await expect(scene.locator('[data-actor-zone]')).toHaveAttribute('data-actor-zone', 'outdoor', { timeout: 20_000 });
  await expect(scene.locator('[data-house-open]')).toHaveAttribute('data-house-open', 'false');
  await page.getByRole('button', { name: island.pause, exact: true }).click();
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('.local/previews', { recursive: true });
  await scene.screenshot({ path: `.local/previews/island-${testInfo.project.name}.png` });
  expect(pageErrors).toEqual([]);
});
