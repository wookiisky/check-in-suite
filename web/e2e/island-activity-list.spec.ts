import { expect, test, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import island from '../src/features/island/content.json' with { type: 'json' };
import { openActivityList } from './island-activity-list-fixtures';

// 完整落在滚动容器内才算可用，避免可见性断言漏掉被裁切的按钮。
async function expectFullyInside(button: Locator) {
  await expect.poll(() => button.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const list = element.closest('.island-activity-buttons')!.getBoundingClientRect();
    return {
      inside: box.left >= list.left - 1 && box.right <= list.right + 1
        && box.top >= list.top - 1 && box.bottom <= list.bottom + 1,
      button: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      list: { left: list.left, right: list.right, top: list.top, bottom: list.bottom },
    };
  })).toEqual(expect.objectContaining({ inside: true }));
}

test('多项动作显示为图标，左右翻动到末项仍能完整点击', async ({ page, isMobile }, testInfo) => {
  await openActivityList(page);
  const list = page.locator('.island-activity-buttons');
  const buttons = list.getByRole('button');
  await expect(buttons).toHaveCount(9);
  expect(await buttons.evaluateAll((elements) => elements.every((element) => {
    const box = element.getBoundingClientRect();
    return element.textContent === '' && element.querySelector('svg') !== null
      && element.getAttribute('title') === element.getAttribute('aria-label')
      && box.width >= 56 && box.height >= 56;
  }))).toBe(true);
  const previous = page.getByRole('button', { name: island.previousActivities, exact: true });
  const next = page.getByRole('button', { name: island.nextActivities, exact: true });
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await expectFullyInside(buttons.first());
  await mkdir('.local/previews', { recursive: true });
  await page.screenshot({ path: `.local/previews/activity-list-${testInfo.project.name}.png` });
  for (let step = 0; step < 15; step += 1) {
    if (await list.evaluate((element) => element.scrollLeft + element.clientWidth >= element.scrollWidth - 1)) break;
    const before = await list.evaluate((element) => element.scrollLeft);
    await next.click();
    await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBeGreaterThan(before);
  }
  await expect(next).toBeDisabled();
  await expect(previous).toBeEnabled();
  await expectFullyInside(buttons.last());
  await buttons.last().click();
  await expect(page.locator('[data-actor-zone]')).toHaveAttribute('data-actor-action', 'run');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.local/previews/activity-list-end-${testInfo.project.name}.png` });
  for (let step = 0; step < 15; step += 1) {
    const before = await list.evaluate((element) => element.scrollLeft);
    if (before <= 1) break;
    await previous.click();
    await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBeLessThan(before);
  }
  await expect(previous).toBeDisabled();
  await expectFullyInside(buttons.first());
  if (isMobile) {
    await page.setViewportSize({ width: 844, height: 390 });
    await expectFullyInside(buttons.first());
    expect(await page.evaluate(() => {
      const dock = document.querySelector('.island-game-dock')!.getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth && dock.right <= innerWidth && dock.bottom <= innerHeight;
    })).toBe(true);
    for (let step = 0; step < 15; step += 1) {
      if (await list.evaluate((element) => element.scrollLeft + element.clientWidth >= element.scrollWidth - 1)) break;
      const before = await list.evaluate((element) => element.scrollLeft);
      await next.click();
      await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBeGreaterThan(before);
    }
    await expect(next).toBeDisabled();
    await expectFullyInside(buttons.last());
    await page.screenshot({ path: '.local/previews/activity-list-landscape.png' });
  }
});

test('逐项聚焦会滚出后面的动作，桌面支持键盘执行', async ({ page, isMobile }) => {
  await openActivityList(page);
  const buttons = page.locator('.island-activity-buttons').getByRole('button');
  await buttons.first().focus();
  for (let index = 1; index < await buttons.count(); index += 1) {
    // iPhone 的默认 Tab 不遍历按钮；手机只验证程序聚焦后的滚入行为。
    if (isMobile) await buttons.nth(index).focus();
    else await page.keyboard.press('Tab');
    await expect(buttons.nth(index)).toBeFocused();
    await expectFullyInside(buttons.nth(index));
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-actor-zone]')).toHaveAttribute('data-actor-action', 'run');
});

for (const count of [0, 2]) {
  test(`活动数量为 ${count} 时不显示无用的翻动按钮`, async ({ page }) => {
    await openActivityList(page, count);
    await expect(page.locator('.island-activity-buttons').getByRole('button')).toHaveCount(count);
    await expect(page.getByRole('button', { name: island.previousActivities, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: island.nextActivities, exact: true })).toHaveCount(0);
  });
}

test('窗口缩窄才出现翻动按钮，变宽后恢复完整列表', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openActivityList(page, 4);
  const next = page.getByRole('button', { name: island.nextActivities, exact: true });
  await expect(next).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(next).toBeEnabled();
  await next.click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(next).toHaveCount(0);
  const buttons = page.locator('.island-activity-buttons').getByRole('button');
  await expectFullyInside(buttons.first());
  await expectFullyInside(buttons.last());
});

test('触控板式横向滚轮只移动动作列表', async ({ page, isMobile }) => {
  test.skip(isMobile, '移动设备项目不以鼠标滚轮替代真实触摸手势');
  await openActivityList(page);
  const list = page.locator('.island-activity-buttons');
  const scene = page.locator('.island-scene');
  const before = await scene.evaluate((element) => [element.getAttribute('data-pan-x'), element.getAttribute('data-pan-y'), element.getAttribute('data-zoom')]);
  await list.hover();
  await page.mouse.wheel(240, 0);
  await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(await scene.evaluate((element) => [element.getAttribute('data-pan-x'), element.getAttribute('data-pan-y'), element.getAttribute('data-zoom')])).toEqual(before);
});
