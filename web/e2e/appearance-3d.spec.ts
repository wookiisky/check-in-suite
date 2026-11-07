import { test, expect } from '@playwright/test';
import type { components } from '../src/api/schema';
import preview from '../src/features/character/character-verification-content.json' with { type: 'json' };
import appearance from '../src/features/shop/appearance-content.json' with { type: 'json' };
import { appearanceAPI, appearanceRequest, openCharacterPreview, ownedAlternativeUpper } from './appearance-flow-fixtures';

type Appearance = components['schemas']['AppearanceState'];

// 三维模型由真实受控资源加载，编辑草稿与主预览中的已保存外观分别存在。
test('真实购买服装后取消与整套保存同步共享人物', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await openCharacterPreview(page);
  const item = await ownedAlternativeUpper(page, `三维上装-${testInfo.project.name}`, 'kaykit-legacy-skeleton-mage-upper');
  const initial = await (await appearanceAPI(page, '/appearance')).json() as Appearance;
  const reset = { ...appearanceRequest(initial), upper_purchase_id: null, upper_free_wearable_key: null };
  expect((await appearanceAPI(page, '/appearance', 'PUT', reset)).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId('character-render-status')).toHaveText(preview.status.ready);
  const before = await (await appearanceAPI(page, '/appearance')).json() as Appearance;
  const originalCanvas = await page.locator('.character-verification-panel canvas').elementHandle();
  await page.getByRole('button', { name: preview.edit, exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('group', { name: appearance.slots.upper, exact: true }).getByRole('radio', { name: item.wearable.name, exact: true }).check();
  expect((await (await appearanceAPI(page, '/appearance')).json() as Appearance).upper_purchase_id).toBeNull();
  await dialog.getByRole('button', { name: appearance.cancel, exact: true }).click();
  await page.getByRole('button', { name: appearance.discard, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await (await appearanceAPI(page, '/appearance')).json() as Appearance).version).toBe(before.version);
  await page.getByRole('button', { name: preview.edit, exact: true }).click(); dialog = page.getByRole('dialog');
  await dialog.getByRole('group', { name: appearance.slots.upper, exact: true }).getByRole('radio', { name: item.wearable.name, exact: true }).check();
  await dialog.getByRole('button', { name: appearance.save, exact: true }).click();
  await expect(dialog.getByText(appearance.saved, { exact: true })).toBeVisible();
  const saved = await (await appearanceAPI(page, '/appearance')).json() as Appearance;
  expect(saved.upper_purchase_id).toBe(item.purchase_id);
  expect(saved.version).toBe(before.version + 1);
  await expect(page.getByTestId('character-saved-version')).toHaveText(`${preview.version} ${saved.version}`);
  expect(await originalCanvas?.evaluate((node) => node.isConnected)).toBe(true);
  await dialog.getByRole('button', { name: appearance.cancel, exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('saved-appearance.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('模型读取失败保留HTML重试与返回入口', async ({ page }) => {
  await openCharacterPreview(page);
  const state = await (await appearanceAPI(page, '/appearance')).json() as Appearance;
  const modelURL = state.characters.find((item) => item.character_key === state.character_key)!.model_url;
  await page.route(`**${modelURL}`, (route) => route.abort());
  await page.reload();
  await expect(page.getByTestId('character-render-status')).toHaveText(preview.status.error);
  await expect(page.getByRole('link', { name: preview.back })).toHaveAttribute('href', '/');
  await page.unroute(`**${modelURL}`);
  await page.getByRole('button', { name: /重.*(试|载|加载)/ }).click();
  await expect(page.getByTestId('character-render-status')).toHaveText(preview.status.ready);
});

// 另一客户端推进版本后，编辑器必须保留草稿并由用户明确核对后再保存。
test('真实外观冲突保留六槽草稿并允许核对当前版本', async ({ page }, testInfo) => {
  await openCharacterPreview(page);
  const item = await ownedAlternativeUpper(page, `冲突上装-${testInfo.project.name}`, 'kaykit-legacy-skeleton-warrior-upper');
  const before = await (await appearanceAPI(page, '/appearance')).json() as Appearance;
  const desired = before.upper_purchase_id === item.purchase_id ? null : item.purchase_id;
  const body = before.characters.find((value) => value.character_key === before.character_key)!;
  const defaultUpper = before.wearables.find((value) => value.wearable_key === body.defaults.upper)!;
  const optionName = desired ? item.wearable.name : appearance.defaultOption.replace('{name}', defaultUpper.name);
  await page.getByRole('button', { name: preview.edit, exact: true }).click();
  const dialog = page.getByRole('dialog');
  const radio = dialog.getByRole('group', { name: appearance.slots.upper, exact: true }).getByRole('radio', { name: optionName, exact: true });
  await radio.check();
  expect((await appearanceAPI(page, '/appearance', 'PUT', appearanceRequest(before))).ok()).toBe(true);
  await dialog.getByRole('button', { name: appearance.save, exact: true }).click();
  await expect(dialog.getByText(appearance.conflict, { exact: true })).toBeVisible();
  await expect(radio).toBeChecked();
  await dialog.getByRole('button', { name: appearance.readLatest, exact: true }).click();
  await dialog.getByRole('button', { name: appearance.keepDraft, exact: true }).click();
  await expect(radio).toBeChecked();
  await dialog.getByRole('button', { name: appearance.save, exact: true }).click();
  await expect(dialog.getByText(appearance.saved, { exact: true })).toBeVisible();
  const saved = await (await appearanceAPI(page, '/appearance')).json() as Appearance;
  expect(saved.upper_purchase_id).toBe(desired);
  expect(saved.version).toBe(before.version + 2);
  await expect(dialog.locator('.character3d-preview')).toHaveAttribute('data-character-status', 'ready');
  await dialog.locator('.appearance-preview').screenshot({ path: testInfo.outputPath('repaired-chest-armor.png') });
});

// 实际提交成功后丢弃响应，核对只能读取结果，不能再产生一次保存。
test('保存响应丢失后核实真实结果并只发布已确认外观', async ({ page }, testInfo) => {
  await openCharacterPreview(page);
  const item = await ownedAlternativeUpper(page, `恢复上装-${testInfo.project.name}`);
  const before = await (await appearanceAPI(page, '/appearance')).json() as Appearance;
  const desired = before.upper_purchase_id === item.purchase_id ? null : item.purchase_id;
  const body = before.characters.find((value) => value.character_key === before.character_key)!;
  const defaultUpper = before.wearables.find((value) => value.wearable_key === body.defaults.upper)!;
  const optionName = desired ? item.wearable.name : appearance.defaultOption.replace('{name}', defaultUpper.name);
  await page.getByRole('button', { name: preview.edit, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('group', { name: appearance.slots.upper, exact: true }).getByRole('radio', { name: optionName, exact: true }).check();
  let dropped = false;
  await page.route('**/api/v1/appearance', async (route) => {
    if (route.request().method() === 'PUT' && !dropped) { dropped = true; const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort(); }
    else await route.continue();
  });
  await dialog.getByRole('button', { name: appearance.save, exact: true }).click();
  await expect(dialog.getByText(appearance.uncertain, { exact: true })).toBeVisible();
  await expect(page.getByTestId('character-saved-version')).toHaveText(`${preview.version} ${before.version}`);
  await dialog.getByRole('button', { name: appearance.checkResult, exact: true }).click();
  await expect(dialog.getByText(appearance.confirmed, { exact: true })).toBeVisible();
  await expect(page.getByTestId('character-saved-version')).toHaveText(`${preview.version} ${before.version + 1}`);
  const saved = await (await appearanceAPI(page, '/appearance')).json() as Appearance;
  expect(saved.version).toBe(before.version + 1);
  expect(saved.upper_purchase_id).toBe(desired);
});
