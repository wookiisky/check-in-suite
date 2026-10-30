import { expect, test } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import family from '../src/features/family/content.json' with { type: 'json' };
import island from '../src/features/island/content.json' with { type: 'json' };

// 自动化检查实际布局和键盘焦点；手机项目只是WebKit仿真，不是真机验收。
test('全页面大字触控、键盘焦点、减少动效和无横向溢出', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await expect(page.getByRole('heading', { name: checkin.todayTasks })).toBeVisible();
  const audit = async (label: string, minFontSize = 22) => {
    const layout = await page.evaluate((minSize) => {
      const visible = (element: Element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
      return {
        width: document.documentElement.scrollWidth, viewport: innerWidth,
        smallText: [...document.querySelectorAll('body *')].filter((element) => visible(element) && [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) && parseFloat(getComputedStyle(element).fontSize) < minSize).map((element) => `${element.tagName}.${element.className}:${getComputedStyle(element).fontSize}`),
        // 复选框与单选框的关联label也是实际点击区域，不能只测方框的视觉尺寸。
        smallControls: [...document.querySelectorAll('button,input,select,textarea,a')].filter(visible).filter((element) => {
          const targets: Element[] = [element];
          if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) targets.push(...Array.from(element.labels ?? []).filter(visible));
          return !targets.some((target) => { const box = target.getBoundingClientRect(); return box.width >= 56 && box.height >= 56; });
        }).map((element) => `${element.tagName}:${element.getAttribute('type') ?? ''}:${element.getBoundingClientRect().width}x${element.getBoundingClientRect().height}`),
        animated: [...document.querySelectorAll('body *')].filter(visible).filter((element) => getComputedStyle(element).animationName !== 'none').map((element) => element.className),
      };
    }, minFontSize);
    expect(layout.width, label).toBeLessThanOrEqual(layout.viewport);
    expect(layout.smallText, label).toEqual([]);
    expect(layout.smallControls, label).toEqual([]);
    expect(layout.animated, label).toEqual([]);
  };
  for (const route of ['camp', 'island', 'calendar', 'stats', 'shop', 'achievements'] as const) {
    await page.getByRole('button', { name: content.navigation[route], exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (route === 'island') await expect(page.locator('.island-scene')).toBeVisible();
    if (route === 'calendar') await expect(page.locator('.calendar-day').first()).toBeVisible();
    if (route === 'camp') { await expect(page.getByRole('heading', { name: checkin.todayTasks })).toBeVisible(); await expect(page.getByRole('heading', { name: family.title })).toBeVisible(); }
    if (route === 'stats') await expect(page.locator('.reports-summary')).toBeVisible();
    if (route === 'shop') await expect(page.locator('.shop-wallet')).toBeVisible();
    if (route === 'achievements') await expect(page.locator('.achievement-grid')).toBeVisible();
    await audit(route);
    if (route === 'camp') {
      const records = await page.locator('.checkin-records-panel').boundingBox();
      const sidebar = await page.locator('.checkin-sidebar').boundingBox();
      const tasks = await page.locator('.checkin-tasks-panel').boundingBox();
      expect(tasks!.y - (records!.y + records!.height)).toBeLessThanOrEqual(25);
      if (testInfo.project.name === 'desktop-chromium') expect(sidebar!.x).toBeGreaterThan(records!.x + records!.width);
      else expect(sidebar!.y).toBeGreaterThan(records!.y + records!.height);
      await page.getByRole('button', { name: checkin.weekView, exact: true }).click();
      await expect(page.locator('.checkin-week-day')).toHaveCount(7);
      await audit('week');
      if (process.env.ISLAND_CAPTURE_PREVIEWS) await page.screenshot({ path: `.local/previews/week-${testInfo.project.name}.png`, fullPage: false });
      await page.getByRole('button', { name: checkin.dayView, exact: true }).click();
    }
    if (process.env.ISLAND_CAPTURE_PREVIEWS) await page.screenshot({ path: `.local/previews/${route}-layout-${testInfo.project.name}.png`, fullPage: false });
    if (route === 'island') await page.getByRole('button', { name: island.back, exact: true }).click();
  }
  const opener = page.getByRole('button', { name: content.navigation.management, exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByRole('button', { name: content.common.close, exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(content.account.managementPassword, { exact: true })).toBeFocused();
  expect(await page.evaluate(() => { const element = document.activeElement; return element && element.matches(':focus-visible') && parseFloat(getComputedStyle(element).outlineWidth) >= 3; })).toBe(true);
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();

  await opener.click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  for (const section of ['account', 'tasks', 'records', 'products', 'achievements'] as const) {
    const name = section === 'achievements' ? content.navigation.achievementManagement : content.navigation[section];
    const tab = page.getByRole('navigation', { name: content.navigation.management, exact: true }).getByRole('button', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-pressed', 'true');
    await audit(section, 18);
  }
});
