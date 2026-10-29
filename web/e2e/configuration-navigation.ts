import { expect, type Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import family from '../src/features/family/content.json' with { type: 'json' };

// 普通页面的声音设置必须通过现有配置入口与管理密码验证。
export async function openConfigurationSettings(page: Page) {
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: family.sounds, exact: true })).toBeVisible();
}

// 退出后等待锁定完成，下一次配置仍须重新输入密码。
export async function closeConfigurationSettings(page: Page) {
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await expect(page.getByRole('button', { name: content.navigation.management, exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: family.sounds, exact: true })).toHaveCount(0);
}
