import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };

// 全屏营地没有普通导航，先通过商店出口回到普通页面。
async function goHome(page: Page) {
  if (await page.locator('.island-page').isVisible()) await page.locator('.island-actions').getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.camp, exact: true }).click();
}

// 入口经过首页，关闭弹窗后继续使用原页面。
export async function openWardrobe(page: Page) {
  await closeWardrobe(page);
  await goHome(page);
  await page.getByRole('button', { name: shop.wardrobeTitle, exact: true }).click();
  await expect(page.getByRole('dialog', { name: shop.wardrobeTitle, exact: true })).toBeVisible();
}

// 仅关闭装扮外层，饰品编辑和未保存确认必须由流程明确处理。
export async function closeWardrobe(page: Page) {
  const dialog = page.getByRole('dialog', { name: shop.wardrobeTitle, exact: true });
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: shop.close, exact: true }).first().click();
}

// 独立背包由商店或首页的明确入口进入。
export async function openBackpack(page: Page) {
  await closeWardrobe(page);
  await goHome(page);
  await page.getByRole('button', { name: shop.backpack, exact: true }).click();
  await expect(page.getByRole('heading', { name: shop.backpack, exact: true })).toBeVisible();
}

// 选择商店两级分类时使用真实 Tab，不依赖旧的页面内标签。
export async function selectShopCategory(page: Page, group: keyof typeof shop.categoryGroups, category?: string) {
  await closeWardrobe(page);
  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await page.getByRole('tablist', { name: shop.categoryGroupLabel, exact: true }).getByRole('tab', { name: shop.categoryGroups[group], exact: true }).click();
  if (category) await page.getByRole('tablist', { name: shop.categoryDetailLabel, exact: true }).getByRole('tab', { name: category, exact: true }).click();
}
