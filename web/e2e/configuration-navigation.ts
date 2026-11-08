import { expect, type Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import family from '../src/features/family/content.json' with { type: 'json' };

// 从普通页面进入独立管理工作区，默认打开账户页签。
export async function openManagement(page: Page) {
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('tab', { name: content.navigation.account, exact: true })).toHaveAttribute('aria-selected', 'true');
}

// 声音设置在管理工作区的单独页签内。
export async function openConfigurationSettings(page: Page) {
  await openManagement(page);
  await page.getByRole('tab', { name: family.sounds, exact: true }).click();
  await expect(page.getByLabel(family.music, { exact: true })).toBeVisible();
}

// 退出后等待锁定完成，下一次配置仍须重新输入密码。
export async function closeConfigurationSettings(page: Page, destination: 'camp' | 'stats' | 'shop' = 'camp') {
  await page.getByRole('navigation', { name: content.navigation.label, exact: true }).getByRole('button', { name: content.navigation[destination], exact: true }).click();
  await expect(page.getByRole('button', { name: content.navigation.management, exact: true })).toBeEnabled();
  await expect(page.getByRole('tablist', { name: content.navigation.management, exact: true })).toHaveCount(0);
}
