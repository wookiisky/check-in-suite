import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import type { components } from '../src/api/schema';

const username = 'island-e2e';
const loginPassword = 'Island-Test-2026';
const managementPassword = 'Manage-Test-2026';
type PasswordKind = 'login' | 'management';

// 通过登录表单建立会话，调用者负责先进入登录页。
async function login(page: Page, password = loginPassword) {
  await page.getByLabel(content.account.username, { exact: true }).fill(username);
  await page.getByLabel(content.account.loginPassword, { exact: true }).fill(password);
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.navigation.camp, exact: true })).toBeVisible();
}

// 进入配置时每次提交当前管理密码，不依赖此前留下的授权。
async function unlock(page: Page, password = managementPassword) {
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill(password);
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
}

// 两种密码表单使用相同字段，限定区域以免把另一种密码一起填写。
async function fillPassword(form: Locator, oldPassword: string, newPassword: string, confirmation = newPassword) {
  await form.getByLabel(content.account.oldPassword, { exact: true }).fill(oldPassword);
  await form.getByLabel(content.account.newPassword, { exact: true }).fill(newPassword);
  await form.getByLabel(content.account.confirmPassword, { exact: true }).fill(confirmation);
}

// 仅用于失败后的清理；正常改密和恢复均经页面，清理请求不充当功能证据。
async function restorePassword(request: APIRequestContext, kind: PasswordKind, currentPassword: string) {
  const response = await request.post('/api/v1/auth/login', {
    data: { username, password: kind === 'login' ? currentPassword : loginPassword },
  });
  expect(response.status(), '恢复测试凭据前须能重新登录').toBe(200);
  const session = await response.json() as components['schemas']['SessionResponse'];
  const headers = { 'X-CSRF-Token': session.csrf_token };
  const unlocked = await request.post('/api/v1/management/unlock', {
    headers, data: { password: kind === 'management' ? currentPassword : managementPassword },
  });
  expect(unlocked.status(), '恢复测试凭据前须有管理授权').toBe(200);
  const original = kind === 'login' ? loginPassword : managementPassword;
  const restored = await request.post(`/api/v1/account/${kind}-password`, {
    headers, data: { old_password: currentPassword, new_password: original, confirm_password: original },
  });
  expect(restored.status(), '失败清理必须恢复原始测试凭据').toBe(204);
}

// 真正更名、错误输入、退出后重进和刷新都使用页面，最后恢复共享账户姓名。
test('管理密码错误可重试，姓名校验和更名刷新形成完整闭环', async ({ page }, testInfo) => {
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(content.account.managementPassword, { exact: true }).fill('Wrong-Management-2026');
  await dialog.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(content.errors.INVALID_CREDENTIALS);
  expect((await page.request.get('/api/v1/session')).status()).toBe(200);
  await expect(dialog.getByLabel(content.account.managementPassword, { exact: true })).toHaveValue('Wrong-Management-2026');
  await dialog.getByLabel(content.account.managementPassword, { exact: true }).fill(managementPassword);
  await dialog.getByRole('button', { name: content.account.unlock, exact: true }).click();
  const name = page.getByLabel(content.account.displayName, { exact: true });
  const originalName = await name.inputValue();
  const renamed = `更名验证-${testInfo.project.name}`;
  try {
    await name.fill('   ');
    await page.getByRole('button', { name: content.account.saveName, exact: true }).click();
    await expect(page.getByText(content.errors.INVALID_LENGTH, { exact: true })).toBeVisible();
    await expect(name).toHaveValue('   ');
    await name.fill(` ${renamed} `);
    await page.getByRole('button', { name: content.account.saveName, exact: true }).click();
    await expect(page.getByText(content.account.nameSaved, { exact: true })).toBeVisible();
    await expect(name).toHaveValue(renamed);
    await expect(page.getByRole('banner').getByText(renamed, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
    await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('banner').getByText(renamed, { exact: true })).toBeVisible();
    await unlock(page);
    await expect(name).toHaveValue(renamed);
  } finally {
    // 优先在当前表单恢复，避免失败时用导航触发另一轮未保存提示。
    if (!await name.isVisible()) {
      await page.goto('/');
      await expect(page.getByRole('button', { name: content.navigation.management, exact: true })).toBeVisible();
      await unlock(page);
    }
    await name.fill(originalName);
    await page.getByRole('button', { name: content.account.saveName, exact: true }).click();
    await expect(page.getByText(content.account.nameSaved, { exact: true })).toBeVisible();
  }
});

// 姓名和两种密码草稿都必须由用户明确放弃，取消离开后原表单仍可继续操作。
test('账户草稿切分区、跨页和退出登录均可继续编辑或明确放弃', async ({ page }, testInfo) => {
  await page.goto('/');
  await login(page);
  await unlock(page);
  const name = page.getByLabel(content.account.displayName, { exact: true });
  const originalName = await name.inputValue();
  const configuration = page.getByRole('navigation', { name: content.navigation.management, exact: true });
  const discardDialog = page.getByRole('dialog', { name: content.account.discardTitle, exact: true });

  await name.fill('尚未保存的姓名');
  await configuration.getByRole('button', { name: content.navigation.tasks, exact: true }).click();
  await expect(discardDialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('account-draft-confirmation.png'), fullPage: false, animations: 'disabled' });
  await discardDialog.getByRole('button', { name: content.account.keepEditing, exact: true }).click();
  await expect(name).toHaveValue('尚未保存的姓名');
  await expect(configuration.getByRole('button', { name: content.navigation.account, exact: true })).toHaveAttribute('aria-pressed', 'true');

  await configuration.getByRole('button', { name: content.navigation.tasks, exact: true }).click();
  await discardDialog.getByRole('button', { name: content.account.discard, exact: true }).click();
  await expect(configuration.getByRole('button', { name: content.navigation.tasks, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await configuration.getByRole('button', { name: content.navigation.account, exact: true }).click();
  await expect(name).toHaveValue(originalName);

  const loginForm = page.getByRole('region', { name: content.account.loginPasswordTitle, exact: true });
  await fillPassword(loginForm, loginPassword, 'Unsaved-Login-2026');
  await page.getByRole('banner').getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await discardDialog.getByRole('button', { name: content.account.keepEditing, exact: true }).click();
  await expect(loginForm.getByLabel(content.account.newPassword, { exact: true })).toHaveValue('Unsaved-Login-2026');
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await discardDialog.getByRole('button', { name: content.account.discard, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.navigation.camp, exact: true })).toBeVisible();
  await unlock(page);
  await expect(loginForm.getByLabel(content.account.newPassword, { exact: true })).toHaveValue('');

  const managementForm = page.getByRole('region', { name: content.account.managementPasswordTitle, exact: true });
  await fillPassword(managementForm, managementPassword, 'Unsaved-Management-2026');
  await page.getByRole('button', { name: content.account.logout, exact: true }).click();
  await discardDialog.getByRole('button', { name: content.account.keepEditing, exact: true }).click();
  await expect(managementForm.getByLabel(content.account.newPassword, { exact: true })).toHaveValue('Unsaved-Management-2026');
  await page.getByRole('button', { name: content.account.logout, exact: true }).click();
  await discardDialog.getByRole('button', { name: content.account.discard, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.loginTitle, exact: true })).toBeVisible();
  await login(page);
  await unlock(page);
  await expect(name).toHaveValue(originalName);
  await expect(managementForm.getByLabel(content.account.newPassword, { exact: true })).toHaveValue('');
});

for (const kind of ['login', 'management'] as const) {
  const title = kind === 'login' ? content.account.loginPasswordTitle : content.account.managementPasswordTitle;
  const action = kind === 'login' ? content.account.changeLoginPassword : content.account.changeManagementPassword;
  const original = kind === 'login' ? loginPassword : managementPassword;
  const replacement = kind === 'login' ? 'Login-Replaced-2026' : 'Manage-Replaced-2026';

  // 错误路径保留输入；成功必须撤销两个独立会话，原密码不能继续使用。
  test(`${title}校验、会话撤销、新旧密码验证与恢复`, async ({ page, request }) => {
    test.setTimeout(90_000);
    let currentPassword = original;
    await page.goto('/');
    await login(page);
    await unlock(page);
    const session = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
    // 独立Cookie会话只用于证明“全部会话撤销”，不替代页面改密流程。
    expect((await request.post('/api/v1/auth/login', { data: { username, password: loginPassword } })).status()).toBe(200);
    const form = page.getByRole('region', { name: title, exact: true });
    const submit = form.getByRole('button', { name: action, exact: true });
    try {
      await fillPassword(form, original, replacement, `${replacement}-mismatch`);
      await submit.click();
      await expect(form.getByText(content.errors.PASSWORD_MISMATCH, { exact: true })).toBeVisible();
      await expect(form.getByLabel(content.account.newPassword, { exact: true })).toHaveValue(replacement);

      const shortPassword = 'x'.repeat(Math.max(1, session.limits.password_min - 1));
      await fillPassword(form, original, shortPassword);
      await submit.click();
      await expect(form.getByText(content.errors.INVALID_LENGTH, { exact: true })).toBeVisible();
      await expect(form.getByLabel(content.account.newPassword, { exact: true })).toHaveValue(shortPassword);

      await fillPassword(form, 'Wrong-Old-Password-2026', replacement);
      await submit.click();
      await expect(form.getByRole('alert')).toContainText(content.errors.INVALID_CREDENTIALS);
      await expect(form.getByLabel(content.account.oldPassword, { exact: true })).toHaveValue('Wrong-Old-Password-2026');
      expect((await page.request.get('/api/v1/session')).status()).toBe(200);

      await fillPassword(form, original, replacement);
      const changed = page.waitForResponse((response) => response.url().endsWith(`/api/v1/account/${kind}-password`) && response.request().method() === 'POST');
      await submit.click();
      expect((await changed).status()).toBe(204);
      currentPassword = replacement;
      await expect(page.getByRole('heading', { name: content.account.loginTitle, exact: true })).toBeVisible();
      await expect(page.getByText(content.account.passwordChanged, { exact: true })).toBeVisible();
      expect((await page.request.get('/api/v1/session')).status()).toBe(401);
      expect((await request.get('/api/v1/session')).status()).toBe(401);

      if (kind === 'login') {
        await page.getByLabel(content.account.username, { exact: true }).fill(username);
        await page.getByLabel(content.account.loginPassword, { exact: true }).fill(original);
        await page.getByRole('button', { name: content.account.login, exact: true }).click();
        await expect(page.getByRole('alert')).toContainText(content.errors.INVALID_CREDENTIALS);
        await login(page, replacement);
        await unlock(page);
      } else {
        await login(page);
        await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
        await page.getByLabel(content.account.managementPassword, { exact: true }).fill(original);
        await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
        await expect(page.getByRole('dialog').getByRole('alert')).toContainText(content.errors.INVALID_CREDENTIALS);
        expect((await page.request.get('/api/v1/session')).status()).toBe(200);
        await page.getByLabel(content.account.managementPassword, { exact: true }).fill(replacement);
        await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
        await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
      }

      await fillPassword(form, replacement, original);
      const restored = page.waitForResponse((response) => response.url().endsWith(`/api/v1/account/${kind}-password`) && response.request().method() === 'POST');
      await submit.click();
      expect((await restored).status()).toBe(204);
      currentPassword = original;
      await expect(page.getByRole('heading', { name: content.account.loginTitle, exact: true })).toBeVisible();
      await login(page);
      await unlock(page);
    } finally {
      if (currentPassword !== original) await restorePassword(request, kind, currentPassword);
    }
  });
}
