import { expect, test, type Locator, type Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };

// 坐标位于弹窗左侧遮罩，使用真实鼠标或触摸，避免绕过浏览器的模态命中规则。
async function clickOutside(page: Page, dialog: Locator, touch: boolean) {
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThan(2);
  const y = box!.y + box!.height / 2;
  if (touch) await page.touchscreen.tap(2, y);
  else await page.mouse.click(2, y);
  // 再点一次遮罩下方的真实页面入口，确认背景按钮不会收到这次操作。
  const background = await page.locator('.site-header nav button:not([aria-current="page"]), .management-sections button:not([aria-pressed="true"])').evaluateAll((elements, bounds) => {
    for (const element of elements) {
      if (element.closest('dialog') || element.matches(':disabled, [aria-current="page"]')) continue;
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      if (rect.width > 0 && rect.height > 0 && x > 0 && x < innerWidth && y > 0 && y < innerHeight
        && (x < bounds.x || x > bounds.x + bounds.width || y < bounds.y || y > bounds.y + bounds.height)) return { x, y };
    }
    return null;
  }, box!);
  expect(background, '弹窗外应有可点击的背景入口供验证').not.toBeNull();
  if (touch) await page.touchscreen.tap(background!.x, background!.y);
  else await page.mouse.click(background!.x, background!.y);
}

// 普通、草稿和确认状态共用公共弹窗；所有编辑都放弃，不改变共享测试账户。
test('弹窗外部点击无响应，主动关闭仍确认草稿并恢复焦点', async ({ page }, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel(content.account.username, { exact: true }).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword, { exact: true }).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();

  const opener = page.getByRole('button', { name: content.navigation.management, exact: true });
  await opener.click();
  const unlock = page.getByRole('dialog', { name: content.account.unlockTitle, exact: true });
  const password = unlock.getByLabel(content.account.managementPassword, { exact: true });
  await password.fill('Manage-Test-2026');
  await clickOutside(page, unlock, touch);
  await expect(unlock).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(password).toHaveValue('Manage-Test-2026');
  await expect(page.getByRole('heading', { name: content.navigation.camp, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(unlock).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.click();
  await password.fill('Manage-Test-2026');
  await unlock.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
  const tasks = page.getByRole('navigation', { name: content.navigation.management, exact: true })
    .getByRole('button', { name: content.navigation.tasks, exact: true });
  await tasks.click();
  const newCategory = page.getByRole('button', { name: checkin.newCategory, exact: true });
  await expect(newCategory).toBeEnabled();
  await newCategory.focus();
  await newCategory.press('Enter');
  const editor = page.getByRole('dialog');
  const name = editor.getByLabel(checkin.name, { exact: true });
  const draft = '弹窗外点击应保留的草稿';
  await name.fill(draft);
  await clickOutside(page, editor, touch);
  await expect(editor).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(name).toHaveValue(draft);
  await expect(editor.getByText(checkin.discardQuestion, { exact: true })).toHaveCount(0);
  await expect(tasks).toHaveAttribute('aria-pressed', 'true');

  await editor.getByRole('button', { name: content.common.close, exact: true }).click();
  const question = editor.getByText(checkin.discardQuestion, { exact: true });
  await expect(question).toBeVisible();
  await clickOutside(page, editor, touch);
  await expect(question).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(tasks).toHaveAttribute('aria-pressed', 'true');
  await editor.getByRole('button', { name: checkin.keepEditing, exact: true }).click();
  await expect(name).toHaveValue(draft);

  await page.keyboard.press('Escape');
  await expect(question).toBeVisible();
  await editor.getByRole('button', { name: checkin.discard, exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(newCategory).toBeFocused();
  await expect(tasks).toHaveAttribute('aria-pressed', 'true');
});
