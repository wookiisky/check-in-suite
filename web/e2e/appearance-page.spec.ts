import { expect, test } from '@playwright/test';
import type { components } from '../src/api/schema';
import app from '../src/content/zh-CN.json' with { type: 'json' };
import appearance from '../src/features/shop/appearance-content.json' with { type: 'json' };
import character from '../src/features/character/character3d-content.json' with { type: 'json' };
import { appearanceAPI, ownedAlternativeUpper } from './appearance-flow-fixtures';

// 正式入口展示可旋转预览，导航离开时由装扮编辑器处理草稿。
test('标题栏打开装扮页，旋转人物并确认离开未保存草稿', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByLabel(app.account.username).fill('island-e2e');
  await page.getByLabel(app.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: app.account.login, exact: true }).click();
  const nav = page.getByRole('navigation', { name: app.navigation.label });
  await expect(nav).toBeVisible();
  const item = await ownedAlternativeUpper(page, `装扮页上装-${testInfo.project.name}`);
  const initial = await (await appearanceAPI(page, '/appearance')).json() as components['schemas']['AppearanceState'];
  const body = initial.characters.find((value) => value.character_key === initial.character_key)!;
  const defaultUpper = initial.wearables.find((value) => value.wearable_key === body.defaults.upper)!;
  const desired = initial.upper_purchase_id === item.purchase_id ? appearance.defaultOption.replace('{name}', defaultUpper.name) : item.wearable.name;

  await nav.getByRole('button', { name: app.navigation.appearance, exact: true }).click();
  await expect(page.getByRole('heading', { name: appearance.pageTitle, exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const model = page.getByRole('region', { name: appearance.previewLabel });
  await expect(model).toHaveAttribute('data-character-status', 'ready');
  await model.getByRole('button', { name: character.rotation.right, exact: true }).click();
  await expect.poll(async () => Number(await model.getAttribute('data-character-rotation'))).toBeCloseTo(Math.PI / 4);

  await page.getByRole('tab', { name: appearance.slots.upper, exact: true }).click();
  const option = page.getByRole('radio', { name: desired, exact: true });
  await option.check();
  const checkin = nav.getByRole('button', { name: app.navigation.camp, exact: true });
  await checkin.click();
  const confirmation = page.getByRole('dialog', { name: appearance.discardTitle });
  await confirmation.getByRole('button', { name: appearance.keepEditing }).click();
  await expect(option).toBeChecked();
  await checkin.click();
  await confirmation.getByRole('button', { name: appearance.discard, exact: true }).click();
  await expect(checkin).toHaveAttribute('aria-current', 'page');
  const after = await (await appearanceAPI(page, '/appearance')).json() as components['schemas']['AppearanceState'];
  expect(after.version).toBe(initial.version);
  expect(after.upper_purchase_id).toBe(initial.upper_purchase_id);
});
