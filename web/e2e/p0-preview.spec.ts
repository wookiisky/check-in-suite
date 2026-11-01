import { test, expect } from '@playwright/test';

// 样片不读取账户、不写数据库，浏览器直接加载发布目录中的真实 GLB。
test('真实模型支持四向室内观察、沿门进出和暂停恢复', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/3d-preview.html');
  await expect(page.getByTestId('p0-status')).toHaveText('动作正在播放');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: '打开屋顶', exact: true }).click();
  for (const direction of ['东南视角', '东北视角', '西北视角', '西南视角']) {
    await expect(page.getByTestId('p0-direction')).toHaveText(direction);
    await testInfo.attach(direction, { body: await page.locator('canvas').screenshot(), contentType: 'image/png' });
    await page.getByRole('button', { name: '向右转', exact: true }).click();
  }
  await page.getByRole('button', { name: '走进房屋', exact: true }).click();
  await expect(page.getByTestId('p0-journey')).toHaveText('人物在屋内', { timeout: 15000 });
  await page.getByRole('button', { name: '暂停动作', exact: true }).click();
  await expect(page.getByTestId('p0-status')).toHaveText('动作已暂停');
  const paused = await page.locator('canvas').screenshot();
  await page.waitForTimeout(350);
  expect(await page.locator('canvas').screenshot()).toEqual(paused);
  await page.getByRole('button', { name: '继续动作', exact: true }).click();
  await page.getByRole('button', { name: '走出房屋', exact: true }).click();
  await expect(page.getByTestId('p0-journey')).toHaveText('人物在屋外', { timeout: 15000 });
  await page.screenshot({ path: testInfo.outputPath('preview.png'), fullPage: true });
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('GLB 读取失败后保留 HTML 操作并能重新下载恢复', async ({ page }) => {
  const model = '**/models/p0/kaykit/rogue.glb';
  await page.route(model, (route) => route.abort());
  await page.goto('/3d-preview.html');
  await expect(page.getByTestId('p0-status')).toContainText('暂时无法显示');
  await expect(page.getByRole('link', { name: '返回成长营地' })).toHaveAttribute('href', '/');
  await page.unroute(model);
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByTestId('p0-status')).toHaveText('动作正在播放');
});

test('系统减少动效保留静态模型及可操作相机', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/3d-preview.html');
  await expect(page.getByTestId('p0-status')).toContainText('系统减少动效已开启');
  await page.getByRole('button', { name: '打开屋顶', exact: true }).click();
  await page.getByRole('button', { name: '向右转', exact: true }).click();
  await expect(page.getByTestId('p0-direction')).toHaveText('东北视角');
  await expect(page.getByRole('button', { name: '走进房屋', exact: true })).toBeDisabled();
  const paused = await page.locator('canvas').screenshot();
  await page.waitForTimeout(300);
  expect(await page.locator('canvas').screenshot()).toEqual(paused);
});
