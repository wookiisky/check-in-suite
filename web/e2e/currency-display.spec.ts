import { expect, test } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import achievement from '../src/features/achievements/content.json' with { type: 'json' };
import island from '../src/features/island/content.json' with { type: 'json' };

// 真实浏览器验证币种标签、指标配置和各页面的图标资源，截图供桌面与手机核对。
test('币种只显示图标，表单与成就指标保留可访问名称', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  const management = page.getByRole('navigation', { name: content.navigation.management, exact: true });
  await management.getByRole('button', { name: content.navigation.tasks, exact: true }).click();
  await page.getByRole('button', { name: checkin.newTask, exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog).not.toContainText(/金币|钻石/);
  await expect(dialog.getByRole('spinbutton', { name: checkin.coins, exact: true })).toBeVisible();
  await expect(dialog.getByRole('spinbutton', { name: checkin.diamonds, exact: true })).toBeVisible();
  await expect(dialog.getByRole('img', { name: checkin.coins, exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: content.common.close, exact: true }).click();

  await management.getByRole('button', { name: content.navigation.products, exact: true }).click();
  await page.getByRole('button', { name: shop.addProduct, exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog).not.toContainText(/金币|钻石/);
  await expect(dialog.getByRole('spinbutton', { name: shop.coinPrice, exact: true })).toBeVisible();
  await expect(dialog.getByRole('spinbutton', { name: shop.diamondPrice, exact: true })).toBeVisible();
  await dialog.screenshot({ path: testInfo.outputPath('product-currency-fields.png') });
  await dialog.getByRole('button', { name: content.common.close, exact: true }).click();

  await management.getByRole('button', { name: achievement.manageTitle, exact: true }).click();
  for (const metric of ['coins', 'diamonds'] as const) {
    const name = `图标验收-${metric}-${testInfo.project.name}`;
    await page.getByRole('button', { name: achievement.new, exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel(achievement.name, { exact: true }).fill(name);
    await dialog.getByRole('radio', { name: achievement.metrics[metric], exact: true }).check();
    await dialog.getByLabel(achievement.target, { exact: true }).fill('12');
    await expect(dialog.getByRole('group', { name: achievement.metric, exact: true })).not.toContainText(/金币|钻石/);
    await expect(dialog.locator('.achievement-target-label')).not.toContainText(/金币|钻石/);
    await expect(dialog.getByRole('radio', { name: achievement.metrics[metric], exact: true })).toBeChecked();
    await dialog.screenshot({ path: testInfo.outputPath(`achievement-${metric}.png`) });
    if (metric === 'coins' && testInfo.project.name === 'desktop-chromium') {
      const viewport = page.viewportSize()!;
      await page.setViewportSize({ width: 768, height: 1024 });
      await dialog.screenshot({ path: testInfo.outputPath('achievement-tablet.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.setViewportSize(viewport);
    }
    await dialog.getByRole('button', { name: achievement.save, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const row = page.locator('.achievement-management-row').filter({ hasText: name });
    await expect(row).not.toContainText(/金币|钻石/);
    await expect(row.locator('.currency-amount')).toHaveText('12');
  }
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  for (const route of ['camp', 'shop', 'island'] as const) {
    await page.getByRole('button', { name: content.navigation[route], exact: true }).click();
    const wallet = page.locator(route === 'island' ? '.island-wallet' : route === 'shop' ? '.shop-wallet' : '.checkin-wallet');
    await expect(wallet).toBeVisible();
    await expect(wallet).not.toContainText(/金币|钻石/);
    const images = wallet.locator('img');
    await expect(images).toHaveCount(2);
    await expect.poll(() => images.evaluateAll((elements) => elements.every((element) => (element as HTMLImageElement).naturalWidth > 0))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`currency-${route}.png`), fullPage: false });
    if (route === 'island') await page.getByRole('button', { name: island.back, exact: true }).click();
  }
});
