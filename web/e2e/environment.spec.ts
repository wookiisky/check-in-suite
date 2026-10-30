import { expect, test } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import family from '../src/features/family/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';

// 浏览器连接真实临时服务，不复用原型或本地用户数据。
test('浏览器通过开发代理连接真实后端并显示登录页', async ({ page, request }) => {
  for (const endpoint of ['/health/live', '/health/ready']) {
    const response = await request.get(endpoint);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/^application\/json\b/);
    expect(await response.json()).toEqual({ status: 'ok' });
  }
  await page.goto('/');
  await expect(page).toHaveTitle(content.appName);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(content.account.loginTitle);
  await expect(page.getByLabel(content.account.username)).toHaveValue('');
});

// API请求不携带Fetch Metadata，真实代理仍须保留Host以识别同源登录和写入。
test('开发代理允许仅带 Origin 的同源登录和写入', async ({ request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const login = await request.post('/api/v1/auth/login', {
    headers: { Origin: origin },
    data: { username: 'island-e2e', password: 'Island-Test-2026' },
  });
  expect(login.status(), await login.text()).toBe(200);
  const session = await login.json() as components['schemas']['SessionResponse'];
  const preferences = await request.patch('/api/v1/account/preferences', {
    headers: { Origin: origin, 'X-CSRF-Token': session.csrf_token },
    data: session.account.preferences,
  });
  expect(preferences.status(), await preferences.text()).toBe(200);
  expect(await preferences.json()).toEqual(session.account.preferences);
});

// 保留Host不能放宽来源限制，未登录和已登录的跨来源写入都必须拒绝。
test('开发代理拒绝仅带 Origin 的跨来源登录和写入', async ({ request }) => {
  const headers = { Origin: 'https://other-origin.invalid' };
  const rejectedLogin = await request.post('/api/v1/auth/login', {
    headers,
    data: { username: 'island-e2e', password: 'Island-Test-2026' },
  });
  expect(rejectedLogin.status()).toBe(403);
  expect(await rejectedLogin.json()).toMatchObject({ code: 'ORIGIN_INVALID' });

  // 无来源头的非浏览器登录建立独立会话，避免同源登录故障掩盖写入拒绝验证。
  const login = await request.post('/api/v1/auth/login', {
    data: { username: 'island-e2e', password: 'Island-Test-2026' },
  });
  expect(login.status(), await login.text()).toBe(200);
  const session = await login.json() as components['schemas']['SessionResponse'];
  const rejectedWrite = await request.patch('/api/v1/account/preferences', {
    headers: { ...headers, 'X-CSRF-Token': session.csrf_token },
    data: session.account.preferences,
  });
  expect(rejectedWrite.status()).toBe(403);
  expect(await rejectedWrite.json()).toMatchObject({ code: 'ORIGIN_INVALID' });
});

// 真实Cookie和CSRF验证登录、锁定与退出；重开管理页必须再次输入密码。
test('真实登录、管理再次验证、姓名保存和退出', async ({ page }, testInfo) => {
  await page.goto('/');
  if (process.env.ISLAND_CAPTURE_PREVIEWS) {
    await expect(page.getByRole('heading', { name: content.account.loginTitle })).toBeVisible();
    await page.screenshot({ path: `.local/previews/login-${testInfo.project.name}.png`, fullPage: true });
  }
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.navigation.camp, exact: true })).toBeVisible();
  const sounds = page.getByRole('heading', { name: family.sounds, exact: true });
  await expect(sounds).toHaveCount(0);
  await expect(page.getByLabel(family.music, { exact: true })).toHaveCount(0);
  if (process.env.ISLAND_CAPTURE_PREVIEWS) {
    await expect(page.getByRole('heading', { name: family.title, exact: true })).toBeVisible();
    await page.screenshot({ path: `.local/previews/camp-settings-hidden-${testInfo.project.name}.png`, fullPage: true });
  }
  const openManagement = page.getByRole('banner').getByRole('button', { name: content.navigation.management, exact: true });
  await expect(page.getByRole('main').getByRole('button', { name: content.navigation.management, exact: true })).toHaveCount(0);
  const entryBounds = await openManagement.boundingBox();
  expect(entryBounds).not.toBeNull();
  expect(entryBounds!.x + entryBounds!.width / 2).toBeGreaterThan(page.viewportSize()!.width / 2);
  expect(entryBounds!.width).toBeGreaterThanOrEqual(56);
  expect(entryBounds!.height).toBeGreaterThanOrEqual(56);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await openManagement.click();
  await expect(page.getByLabel(content.account.managementPassword, { exact: true })).toBeVisible();
  await expect(sounds).toHaveCount(0);
  await expect(page.getByLabel(family.music, { exact: true })).toHaveCount(0);
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
  await expect(sounds).toBeVisible();
  await expect(page.getByLabel(family.music, { exact: true })).toBeVisible();
  await expect(page.getByLabel(content.account.displayName)).toHaveValue('测试小朋友');
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await page.screenshot({ path: `.local/previews/account-${testInfo.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: content.account.saveName, exact: true }).click();
  // 两个浏览器项目可能同时保存同一资料版本，冲突必须可见而非覆盖。
  await expect(page.getByText(content.account.nameSaved).or(page.getByText(content.errors.VERSION_CONFLICT))).toBeVisible();
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await expect(openManagement).toBeEnabled();
  await expect(sounds).toHaveCount(0);
  await expect(page.getByLabel(family.music, { exact: true })).toHaveCount(0);
  await openManagement.click();
  await expect(page.getByLabel(content.account.managementPassword, { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: content.common.cancel, exact: true }).click();
  await expect(openManagement).toBeFocused();
  await page.getByRole('button', { name: content.account.logout, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.loginTitle, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: content.account.loginTitle, exact: true })).toBeVisible();
});

// 模拟390px只验证布局，不声称通过真实设备采集或播放验证。
test('390px宽度保留大字、触控目标且无页面横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: content.account.loginTitle })).toBeVisible();
  const layout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    fontSize: Number.parseFloat(getComputedStyle(document.body).fontSize),
    controls: [...document.querySelectorAll('button,input')].map((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })),
  }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.fontSize).toBeGreaterThanOrEqual(22);
  for (const control of layout.controls) {
    expect(control.width).toBeGreaterThanOrEqual(56);
    expect(control.height).toBeGreaterThanOrEqual(56);
  }
});
