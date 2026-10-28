import { expect, test } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };

test('浏览器通过开发代理连接真实后端', async ({ page, request }) => {
  for (const endpoint of ['/health/live', '/health/ready']) {
    const response = await request.get(endpoint);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/^application\/json\b/);
    expect(await response.json()).toEqual({ status: 'ok' });
  }

  await page.goto('/');
  await expect(page).toHaveTitle(content.appName);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(content.heading);
  await expect(page.getByRole('status')).toHaveText(content.connection.ready);
});

test('iPhone 14 宽度保留大字且页面不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText(content.connection.ready);

  const layout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    fontSize: Number.parseFloat(getComputedStyle(document.body).fontSize),
  }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.fontSize).toBeGreaterThanOrEqual(22);
});
