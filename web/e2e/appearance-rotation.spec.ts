import { test, expect } from '@playwright/test';
import type { CDPSession, Locator, Page } from '@playwright/test';
import type { components } from '../src/api/schema';
import preview from '../src/features/character/character-verification-content.json' with { type: 'json' };
import character from '../src/features/character/character3d-content.json' with { type: 'json' };
import appearance from '../src/features/shop/appearance-content.json' with { type: 'json' };
import { appearanceAPI, openCharacterPreview, ownedAlternativeUpper } from './appearance-flow-fixtures';

type Appearance = components['schemas']['AppearanceState'];

// 朝向读自真实预览，画面变化另用实际 Canvas 截图验证。
async function rotationOf(preview: Locator) {
  return Number(await preview.getAttribute('data-character-rotation'));
}

// 减少动效固定动作首帧，使截图比较只观察用户操作带来的朝向变化。
test('装扮可绕一周查看且换装保存保留朝向', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && /THREE|WebGL|shader/i.test(message.text())) errors.push(message.text()); });
  await openCharacterPreview(page);
  await expect(page.getByRole('button', { name: character.rotation.right, exact: true })).toHaveCount(0);
  const item = await ownedAlternativeUpper(page, `旋转上装-${testInfo.project.name}`);
  const before = await (await appearanceAPI(page, '/appearance')).json() as Appearance;
  let writes = 0;
  page.on('request', (request) => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v1/appearance') writes += 1; });
  await page.getByRole('button', { name: preview.edit, exact: true }).click();
  const dialog = page.getByRole('dialog');
  const model = dialog.locator('.character3d-preview');
  const canvas = model.locator('canvas');
  await expect(model).toHaveAttribute('data-character-status', 'ready');
  await expect.poll(() => rotationOf(model)).toBeCloseTo(0);
  for (const name of [character.rotation.left, character.rotation.reset, character.rotation.right]) {
    const button = dialog.getByRole('button', { name, exact: true });
    expect(await button.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return hit !== null && node.contains(hit);
    }), `${name}的中心应能直接点击`).toBe(true);
  }
  await model.screenshot({ path: testInfo.outputPath('rotation-controls.png') });
  const initial = await canvas.screenshot({ path: testInfo.outputPath('rotation-initial.png') });
  const right = dialog.getByRole('button', { name: character.rotation.right, exact: true });
  await right.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => rotationOf(model)).toBeCloseTo(Math.PI / 4);
  // 验证需求渲染在减少动效时也确实更新，不能只靠 HTML 的角度属性判定。
  await expect.poll(async () => (await canvas.screenshot()).equals(initial)).toBe(false);
  await canvas.screenshot({ path: testInfo.outputPath('rotation-45-degrees.png') });
  for (let step = 1; step < 8; step += 1) await right.click();
  await expect.poll(() => rotationOf(model)).toBeCloseTo(0);
  expect(writes).toBe(0);
  expect(((await (await appearanceAPI(page, '/appearance')).json()) as Appearance).version).toBe(before.version);
  await dialog.getByRole('button', { name: character.rotation.left, exact: true }).click();
  await expect.poll(() => rotationOf(model)).toBeCloseTo(7 * Math.PI / 4);
  await dialog.getByRole('button', { name: character.rotation.reset, exact: true }).click();
  await expect.poll(() => rotationOf(model)).toBeCloseTo(0);
  for (let step = 0; step < 4; step += 1) await right.click();
  const desired = before.upper_purchase_id === item.purchase_id ? null : item.purchase_id;
  const body = before.characters.find((value) => value.character_key === before.character_key)!;
  const defaultUpper = before.wearables.find((value) => value.wearable_key === body.defaults.upper)!;
  const option = desired ? item.wearable.name : appearance.defaultOption.replace('{name}', defaultUpper.name);
  await dialog.getByRole('group', { name: appearance.slots.upper, exact: true }).getByRole('radio', { name: option, exact: true }).check();
  await expect(model).toHaveAttribute('data-character-status', 'ready');
  await expect.poll(() => rotationOf(model)).toBeCloseTo(Math.PI);
  await canvas.screenshot({ path: testInfo.outputPath('rotation-changed-outfit-back.png') });
  await dialog.getByRole('button', { name: appearance.save, exact: true }).click();
  await expect(dialog.getByText(appearance.saved, { exact: true })).toBeVisible();
  await expect.poll(() => rotationOf(model)).toBeCloseTo(Math.PI);
  const saved = await (await appearanceAPI(page, '/appearance')).json() as Appearance;
  expect(saved.upper_purchase_id).toBe(desired);
  expect(saved.version).toBe(before.version + 1);
  expect(writes).toBe(1);
  await dialog.getByRole('button', { name: appearance.cancel, exact: true }).click();
  await page.getByRole('button', { name: preview.edit, exact: true }).click();
  await expect(page.getByRole('dialog').locator('.character3d-preview')).toHaveAttribute('data-character-status', 'ready');
  await expect.poll(() => rotationOf(page.getByRole('dialog').locator('.character3d-preview'))).toBeCloseTo(0);
  expect(errors).toEqual([]);
});

// Playwright 的真实鼠标事件覆盖捕获与松手；手机项目的原生触屏拖动另需真机验证。
test('鼠标横向拖动旋转并在松手后停止', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', '此用例验证桌面鼠标，手机尺寸项目由按钮流程覆盖。');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openCharacterPreview(page);
  await page.getByRole('button', { name: preview.edit, exact: true }).click();
  const model = page.getByRole('dialog').locator('.character3d-preview');
  const stage = model.locator('.character3d-stage');
  await expect(model).toHaveAttribute('data-character-status', 'ready');
  const bounds = await stage.boundingBox();
  expect(bounds).not.toBeNull();
  const { x, y, width, height } = bounds!;
  await page.mouse.move(x + width / 4, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + 3 * width / 4, y + height / 2, { steps: 8 });
  await expect.poll(() => rotationOf(model)).toBeCloseTo(Math.PI, 1);
  await page.mouse.up();
  const released = await rotationOf(model);
  await page.mouse.move(x + width / 3, y + height / 2, { steps: 4 });
  expect(await rotationOf(model)).toBe(released);
  await page.getByRole('dialog').getByRole('button', { name: character.rotation.reset, exact: true }).click();
  await page.mouse.move(x + width / 2, y + height / 3);
  await page.mouse.down();
  await page.mouse.move(x + width / 2 + 1, y + 2 * height / 3, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => rotationOf(model)).toBeCloseTo(0);
});

// CDP 将触摸送入浏览器输入管线，每步等一帧，覆盖原生手势判定与 pointercancel。
async function swipeTouch(session: CDPSession, page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
  try {
    for (let step = 1; step <= 12; step += 1) {
      const x = from.x + (to.x - from.x) * step / 12;
      const y = from.y + (to.y - from.y) * step / 12;
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    }
  } finally {
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

test.describe('Chromium 触屏浏览器模拟', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  // 此处验证浏览器触摸处理和实际弹窗滚动，不代表手机硬件或 WebKit 原生滑动验证。
  test('横滑旋转人物且纵滑仍滚动装扮弹窗', async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', '此专项使用 Chromium CDP，不能在 WebKit 中运行。');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCharacterPreview(page);
    await page.getByRole('button', { name: preview.edit, exact: true }).click();
    const dialog = page.getByRole('dialog');
    const model = dialog.locator('.character3d-preview');
    const stage = model.locator('.character3d-stage');
    await expect(model).toHaveAttribute('data-character-status', 'ready');
    await dialog.evaluate((node) => { node.scrollTop = 0; });
    const horizontal = await stage.boundingBox();
    expect(horizontal).not.toBeNull();
    const session = await context.newCDPSession(page);
    try {
      const { x, y, width, height } = horizontal!;
      await swipeTouch(session, page, { x: x + width / 4, y: y + height / 2 }, { x: x + 3 * width / 4, y: y + height / 2 });
      await expect.poll(() => rotationOf(model)).toBeGreaterThan(1);
      await expect.poll(() => dialog.evaluate((node) => node.scrollTop)).toBe(0);
      await dialog.getByRole('button', { name: character.rotation.reset, exact: true }).tap();
      await expect.poll(() => rotationOf(model)).toBeCloseTo(0);
      await dialog.evaluate((node) => { node.scrollTop = 0; });
      expect(await dialog.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(0);
      const vertical = await stage.boundingBox();
      expect(vertical).not.toBeNull();
      const start = vertical!;
      await swipeTouch(session, page, { x: start.x + start.width / 2, y: start.y + 3 * start.height / 4 }, { x: start.x + start.width / 2, y: start.y + start.height / 4 });
      await expect.poll(() => dialog.evaluate((node) => node.scrollTop)).toBeGreaterThan(20);
      await expect.poll(() => rotationOf(model)).toBeCloseTo(0);
    } finally {
      await session.detach();
    }
  });
});
