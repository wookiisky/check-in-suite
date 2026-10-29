import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import island from '../src/features/island/content.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import family from '../src/features/family/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';

// 测试条件与结果通过当前浏览器的真实会话读写，保留请求保护。
async function hudAPI<T>(page: Page, path: string, method = 'GET', data?: unknown): Promise<T> {
  const session = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  const response = await page.request.fetch(`/api/v1${path}`, {
    method, data, headers: { Origin: 'http://127.0.0.1:15173', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.status() === 204 ? undefined as T : response.json() as Promise<T>;
}

// 全屏尺寸与触控检查使用实际DOM布局，不把截图尺寸当作布局证据。
async function expectFullscreen(page: Page) {
  await expect(page.locator('.island-fullscreen')).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const frame = document.querySelector('.island-fullscreen')!.getBoundingClientRect();
    return Math.abs(frame.left) < 1 && Math.abs(frame.top) < 1 && Math.abs(frame.width - innerWidth) < 2 && Math.abs(frame.height - innerHeight) < 2;
  })).toBe(true);
  expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth <= innerWidth, height: document.documentElement.scrollHeight <= innerHeight + 1 }))).toEqual({ width: true, height: true });
  await expect(page.getByRole('navigation', { name: content.navigation.label, exact: true })).toHaveCount(0);
  const typography = await page.locator('.island-fullscreen').evaluate((root) => {
    const visible = (element: Element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
    return {
      smallText: [...root.querySelectorAll('*')].filter(visible).filter((element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) && parseFloat(getComputedStyle(element).fontSize) < 18).map((element) => element.className),
      smallButtons: [...root.querySelectorAll('button')].filter(visible).filter((element) => { const box = element.getBoundingClientRect(); return box.width < 56 || box.height < 56; }).map((element) => element.textContent),
    };
  });
  expect(typography).toEqual({ smallText: [], smallButtons: [] });
  await expect(page.locator('.island-actions').getByRole('button', { name: island.shop, exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: island.shop, exact: true })).toHaveCount(1);
  if (await page.locator('.island-game-dock').count()) {
    const actions = page.locator('.island-actions');
    const dock = page.locator('.island-game-dock');
    for (const name of [island.edit, island.shop]) {
      await expect(actions.getByRole('button', { name, exact: true })).toHaveCount(1);
      await expect(dock.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    // 相对视口测量角落位置，横竖屏不依赖固定画布尺寸。
    await expect.poll(() => page.evaluate(() => {
      const dockBox = document.querySelector('.island-game-dock')!.getBoundingClientRect();
      const actionBox = document.querySelector('.island-actions')!.getBoundingClientRect();
      const headerBox = document.querySelector('.island-page-header')!.getBoundingClientRect();
      return dockBox.right <= innerWidth && innerWidth - dockBox.right <= 24
        && dockBox.bottom <= innerHeight && innerHeight - dockBox.bottom <= 24
        && actionBox.right <= innerWidth && innerWidth - actionBox.right <= 24
        && actionBox.top >= headerBox.top && actionBox.bottom <= headerBox.bottom;
    })).toBe(true);
  }
}

// 独立入口、返回来源与手机横竖屏都经过真实应用导航。
test('全屏小岛保留大字触控、返回来源与设置，适配手机横竖屏', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  await expect(page.locator('.island-scene')).toBeVisible();
  await expectFullscreen(page);
  await page.getByRole('button', { name: island.settings, exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: family.sounds, exact: true })).toBeVisible();
  const effects = page.getByRole('dialog').getByRole('checkbox', { name: family.effects, exact: true });
  const effectsBefore = await effects.isChecked();
  // 偏好在服务端保存成功后才更新受控值，真实点击后等待异步结果。
  await effects.click();
  await expect(effects).toBeEnabled();
  await expect(effects).toBeChecked({ checked: !effectsBefore });
  await effects.click();
  await expect(effects).toBeEnabled();
  await expect(effects).toBeChecked({ checked: effectsBefore });
  await page.getByRole('dialog').getByRole('button', { name: content.common.close, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: island.settings, exact: true })).toBeFocused();
  await page.getByRole('button', { name: island.back, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.navigation.camp, exact: true })).toBeVisible();
  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await page.getByRole('button', { name: shop.islandInventory, exact: true }).click();
  await page.getByRole('button', { name: shop.goToIsland, exact: true }).click();
  await expect(page.locator('.island-scene')).toBeVisible();
  await page.getByRole('button', { name: island.back, exact: true }).click();
  await expect(page.getByRole('heading', { name: shop.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  await expect(page.locator('.island-scene')).toBeVisible();
  await page.locator('.island-actions').getByRole('button', { name: island.shop, exact: true }).click();
  await expect(page.getByRole('heading', { name: shop.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  await expect(page.locator('.island-scene')).toBeVisible();
  await mkdir('.local/previews', { recursive: true });
  await page.screenshot({ path: `.local/previews/island-fullscreen-${testInfo.project.name}.png`, fullPage: true });
  if (testInfo.project.use.isMobile) {
    await page.setViewportSize({ width: 844, height: 390 });
    await expectFullscreen(page);
    await page.screenshot({ path: '.local/previews/island-fullscreen-mobile-landscape.png', fullPage: true });
  }
});

// 保存失败不得执行返回，关闭物品抽屉也不得丢失当前布置。
test('全屏布置抽屉独立滚动，离开时保存失败保留草稿', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  const scene = page.getByRole('group', { name: island.scene, exact: true });
  await expect(scene).toBeVisible();
  const initial = await (await page.request.get('/api/v1/island')).json() as { version: number; placements: { id: string; x: number; y: number }[]; catalog: { key: string; name: string }[] };
  const run = initial.catalog.find((item) => item.key === 'run')!;
  await page.getByRole('button', { name: island.edit, exact: true }).click();
  await page.locator('.island-placed-list').getByRole('button', { name: run.name, exact: true }).click();
  const object = scene.locator('[data-placement-id="base:run"]');
  const transform = await object.getAttribute('transform');
  await page.getByRole('button', { name: island.moveRight, exact: true }).click();
  await expect(object).not.toHaveAttribute('transform', transform!);
  await expectFullscreen(page);
  for (const name of [island.zoomIn, island.zoomOut, island.resetView]) {
    await page.getByRole('button', { name, exact: true }).click({ timeout: 5_000 });
  }
  await mkdir('.local/previews', { recursive: true });
  await page.screenshot({ path: `.local/previews/island-fullscreen-editor-${testInfo.project.name}.png`, fullPage: true });
  const panBefore = await scene.getAttribute('data-pan-x');
  const panYBefore = await scene.getAttribute('data-pan-y');
  if (testInfo.project.use.isMobile) {
    await page.locator('.island-editor-scroll button').last().focus();
    await page.keyboard.press('PageDown');
  } else {
    await page.locator('.island-editor-scroll').hover();
    await page.mouse.wheel(0, 240);
  }
  await expect.poll(() => page.locator('.island-editor-scroll').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await scene.getAttribute('data-pan-x')).toBe(panBefore);
  expect(await scene.getAttribute('data-pan-y')).toBe(panYBefore);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.getByRole('button', { name: island.closeInventory, exact: true }).click();
  await expect(page.locator('#island-inventory-panel')).not.toBeVisible();
  await page.getByRole('button', { name: island.openInventory, exact: true }).click();
  await expect(page.locator('#island-inventory-panel')).toBeVisible();
  await expect(object).not.toHaveAttribute('transform', transform!);
  if (testInfo.project.use.isMobile) {
    const portraitViewport = page.viewportSize()!;
    await page.setViewportSize({ width: 844, height: 390 });
    await expectFullscreen(page);
    await expect(page.getByRole('button', { name: island.save, exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: island.cancel, exact: true })).toBeInViewport({ ratio: 1 });
    for (const name of [island.zoomIn, island.zoomOut, island.resetView]) {
      await page.getByRole('button', { name, exact: true }).click({ timeout: 5_000 });
    }
    await page.screenshot({ path: '.local/previews/island-fullscreen-mobile-landscape-edit.png', fullPage: true });
    await page.setViewportSize(portraitViewport);
  }
  await page.getByRole('button', { name: island.back, exact: true }).click();
  await expect(page.getByRole('dialog', { name: island.leaveTitle })).toBeVisible();
  await page.route('**/api/v1/island', async (route) => {
    if (route.request().method() === 'PUT') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', field_errors: {}, request_id: 'fullscreen-save-failure' }) });
    else await route.continue();
  });
  await page.getByRole('button', { name: island.saveAndLeave, exact: true }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.locator('.island-fullscreen')).toBeVisible();
  expect((await (await page.request.get('/api/v1/island')).json()).version).toBe(initial.version);
  await page.unroute('**/api/v1/island');
  if (!await page.getByRole('button', { name: island.keepEditing, exact: true }).isVisible()) await page.getByRole('button', { name: island.back, exact: true }).click();
  await page.getByRole('button', { name: island.keepEditing, exact: true }).click();
  await expect(scene).toHaveAttribute('data-editing', 'true');
  await page.getByRole('button', { name: island.back, exact: true }).click();
  await page.getByRole('button', { name: island.saveAndLeave, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.navigation.camp, exact: true })).toBeVisible();
  const saved = await (await page.request.get('/api/v1/island')).json();
  expect(saved.version).toBe(initial.version + 1);
  expect(saved.placements.find((item: { id: string }) => item.id === 'base:run')).not.toEqual(initial.placements.find((item) => item.id === 'base:run'));
});

// 快捷入口只导航；任务可用性和余额来自与主界面相同的实际服务端数据。
test('小岛展示可折叠打卡入口和真实余额，任务跳转保留布置保护', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.navigation.camp, exact: true })).toBeVisible();
  await hudAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
  const taskInput = { category_id: null, icon_key: 'book-v1', coin_reward: 7, diamond_reward: 3, daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true };
  const pending = await hudAPI<components['schemas']['Task']>(page, '/management/tasks', 'POST', { ...taskInput, name: `小岛待打卡-${testInfo.project.name}` });
  const completed = await hudAPI<components['schemas']['Task']>(page, '/management/tasks', 'POST', { ...taskInput, name: `小岛已打卡-${testInfo.project.name}` });
  const before = await hudAPI<components['schemas']['CampResponse']>(page, '/camp');
  await hudAPI(page, '/checkins', 'POST', { expected_today: before.today, task_id: completed.id, expected_task_version: completed.version, text: '', photo_media_id: null, audio_media_id: null });
  const camp = await hudAPI<components['schemas']['CampResponse']>(page, '/camp');
  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  const shortcuts = page.locator('.island-checkin-panel');
  const wallet = page.locator('.island-wallet');
  await expect(shortcuts.getByRole('button', { name: pending.name, exact: true })).toBeVisible();
  const taskButton = shortcuts.getByRole('button', { name: pending.name, exact: true });
  await expect(taskButton).toHaveAttribute('aria-label', pending.name);
  await expect(taskButton).toHaveText('');
  await expect(taskButton.locator('img')).toHaveCount(1);
  await expect(shortcuts.getByRole('button', { name: completed.name, exact: true })).toHaveCount(0);
  await expect(shortcuts.locator('.checkin-icon')).toHaveCount(camp.tasks.length);
  await expect(wallet.locator('.currency-amount')).toHaveText([String(camp.wallet.coins), String(camp.wallet.diamonds)]);
  await expect(wallet.getByRole('img', { name: shop.coins, exact: true })).toBeVisible();
  await expect(wallet.getByRole('img', { name: shop.diamonds, exact: true })).toBeVisible();
  await page.getByRole('button', { name: island.collapseCheckins, exact: true }).click();
  await expect(shortcuts.getByRole('button', { name: pending.name, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: island.expandCheckins, exact: true }).click();
  await expect(shortcuts.getByRole('button', { name: pending.name, exact: true })).toBeVisible();
  await expectFullscreen(page);
  for (const name of [island.zoomIn, island.zoomOut, island.resetView]) await page.getByRole('button', { name, exact: true }).click({ timeout: 5_000 });
  await mkdir('.local/previews', { recursive: true });
  await page.screenshot({ path: `.local/previews/island-hud-${testInfo.project.name}.png`, fullPage: true });
  if (testInfo.project.use.isMobile) {
    const portrait = page.viewportSize()!;
    await page.setViewportSize({ width: 844, height: 390 });
    await expectFullscreen(page);
    for (const name of [island.zoomIn, island.zoomOut, island.resetView]) await page.getByRole('button', { name, exact: true }).click({ timeout: 5_000 });
    await page.screenshot({ path: '.local/previews/island-hud-mobile-landscape.png', fullPage: true });
    await page.setViewportSize(portrait);
  }
  // 即使从商店进入岛，点击打卡项也应去营地主界面，而非返回来源页或直接提交。
  await shortcuts.getByRole('button', { name: pending.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.navigation.camp, exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await hudAPI<components['schemas']['CampResponse']>(page, '/camp')).tasks.some((task) => task.id === pending.id)).toBe(true);
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  const initial = await hudAPI<components['schemas']['IslandState']>(page, '/island');
  await page.getByRole('button', { name: island.edit, exact: true }).click();
  await page.locator('.island-placed-list').getByRole('button', { name: initial.catalog.find((item) => item.key === 'run')!.name, exact: true }).click();
  await page.getByRole('button', { name: island.moveRight, exact: true }).click();
  await page.getByRole('button', { name: island.expandCheckins, exact: true }).click();
  await shortcuts.getByRole('button', { name: pending.name, exact: true }).click();
  await expect(page.getByRole('dialog', { name: island.leaveTitle })).toBeVisible();
  await page.getByRole('button', { name: island.keepEditing, exact: true }).click();
  await expect(page.locator('.island-scene')).toHaveAttribute('data-editing', 'true');
  await shortcuts.getByRole('button', { name: pending.name, exact: true }).click();
  await page.getByRole('button', { name: island.discardAndLeave, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.navigation.camp, exact: true })).toBeVisible();
  expect((await hudAPI<components['schemas']['IslandState']>(page, '/island')).version).toBe(initial.version);
  await hudAPI(page, '/checkins', 'POST', { expected_today: camp.today, task_id: pending.id, expected_task_version: pending.version, text: '', photo_media_id: null, audio_media_id: null });
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  const updated = await hudAPI<components['schemas']['CampResponse']>(page, '/camp');
  await expect(shortcuts.getByRole('button', { name: pending.name, exact: true })).toHaveCount(0);
  await expect(wallet.locator('.currency-amount')).toHaveText([String(updated.wallet.coins), String(updated.wallet.diamonds)]);
});
