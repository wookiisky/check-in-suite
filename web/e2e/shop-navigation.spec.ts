import { expect, test } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import appearance from '../src/features/shop/appearance-content.json' with { type: 'json' };
import pagination from '../src/components/numbered-pagination-content.json' with { type: 'json' };
import { loginMain, openAppearance, selectShopCategory } from './shop-navigation';

test('装扮为独立页面，商店保留两级键盘导航和页码跳转', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loginMain(page);
  await openAppearance(page);
  await expect(page.locator('.appearance-page').getByRole('heading', { name: appearance.pageTitle, exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: appearance.title, exact: true })).toHaveCount(0);
  await selectShopCategory(page, 'appearance', shop.wearableSlots.head);
  const details = page.getByRole('tablist', { name: shop.categoryDetailLabel, exact: true });
  await details.getByRole('tab', { name: shop.wearableSlots.head, exact: true }).press('ArrowRight');
  await expect(details.getByRole('tab', { name: shop.wearableSlots.upper, exact: true })).toBeFocused();
  await expect(details.getByRole('tab', { name: shop.wearableSlots.upper, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(details.getByRole('tab', { name: shop.types.title, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: shop.backpack, exact: true })).toHaveCount(0);

  await selectShopCategory(page, 'island');
  const pager = page.getByRole('navigation', { name: pagination.label, exact: true });
  await pager.getByRole('spinbutton', { name: pagination.page, exact: true }).fill('2');
  const next = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/shop/products' && url.searchParams.get('page') === '2';
  });
  await pager.getByRole('button', { name: pagination.jump, exact: true }).click();
  expect((await next).ok()).toBe(true);
  await expect(pager.locator('[aria-current="page"]')).toContainText('2 /');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: shop.openAppearance, exact: true }).last().click();
  await expect(page.locator('.appearance-page')).toBeVisible();
  await expect(page.getByRole('navigation', { name: content.navigation.label }).getByRole('button', { name: content.navigation.appearance })).toHaveAttribute('aria-current', 'page');
});
