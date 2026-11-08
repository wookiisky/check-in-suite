import { expect, test, type Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import family from '../src/features/family/content.json' with { type: 'json' };
import reports from '../src/features/reports/content.json' with { type: 'json' };
import achievement from '../src/features/achievements/content.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };

// 核对主页面和管理页各自的文字和触控下限，以及无横向溢出。
async function audit(page: Page, label: string, fontSize = 22, targetSize = 56) {
  const layout = await page.evaluate(({ fontSize, targetSize }) => {
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden' && !element.classList.contains('sr-only');
    };
    return {
      width: document.documentElement.scrollWidth, viewport: innerWidth,
      smallText: [...document.querySelectorAll('body *')].filter((element) => visible(element) && [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) && parseFloat(getComputedStyle(element).fontSize) < fontSize).map((element) => `${element.tagName}.${element.className}:${getComputedStyle(element).fontSize}`),
      // 复选框与单选框的关联label也是实际点击区域，不能只测方框的视觉尺寸。
      smallControls: [...document.querySelectorAll('button,input,select,textarea,a')].filter(visible).filter((element) => {
        const targets: Element[] = [element];
        if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) targets.push(...Array.from(element.labels ?? []).filter(visible));
        return !targets.some((target) => { const box = target.getBoundingClientRect(); return box.width >= targetSize && box.height >= targetSize; });
      }).map((element) => `${element.tagName}:${element.getAttribute('type') ?? ''}:${element.getBoundingClientRect().width}x${element.getBoundingClientRect().height}`),
      animated: [...document.querySelectorAll('body *')].filter(visible).filter((element) => getComputedStyle(element).animationName !== 'none').map((element) => element.className),
    };
  }, { fontSize, targetSize });
  expect(layout.width, label).toBeLessThanOrEqual(layout.viewport);
  expect(layout.smallText, label).toEqual([]);
  expect(layout.smallControls, label).toEqual([]);
  expect(layout.animated, label).toEqual([]);
}

// 自动化检查实际布局和键盘焦点；手机项目只是WebKit仿真，不是真机验收。
test('全页面大字触控、键盘焦点、减少动效和无横向溢出', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await expect(page.getByRole('heading', { name: checkin.todayTasks })).toBeVisible();
  const primaryRoutes = ['camp', 'island', 'stats', 'shop', 'appearance'] as const;
  const navigation = page.getByRole('navigation', { name: content.navigation.label, exact: true });
  for (const route of primaryRoutes) {
    await navigation.getByRole('button', { name: content.navigation[route], exact: true }).click();
    const pageMarker = route === 'shop'
      ? page.getByRole('tablist', { name: shop.categoryGroupLabel, exact: true })
      : page.getByRole('heading', { level: 1 });
    await expect(pageMarker).toBeVisible();
    await expect(navigation.getByRole('button')).toHaveText(primaryRoutes.map((item) => content.navigation[item]));
    if (route === 'island') await expect(page.locator('.spatial-stage')).toBeVisible();
    if (route === 'shop') await expect(page.locator('.global-wallet')).toBeVisible();
    if (route === 'stats') {
      await expect(page.locator('.calendar-day').first()).toBeVisible();
      await audit(page, 'month');
      await page.getByRole('tab', { name: reports.weekView, exact: true }).click();
      await expect(page.locator('.reports-week-day')).toHaveCount(7);
      await audit(page, 'week');
      if (process.env.ISLAND_CAPTURE_PREVIEWS) await page.screenshot({ path: `.local/previews/week-${testInfo.project.name}.png`, fullPage: false });
      await page.getByRole('tab', { name: reports.statsView, exact: true }).click();
      await expect(page.locator('.reports-summary')).toBeVisible();
    }
    if (route === 'camp') {
      await expect(page.getByRole('heading', { name: checkin.todayTasks })).toBeVisible();
      await expect(page.getByRole('heading', { name: family.title })).toBeVisible();
      await expect(page.getByRole('tab', { name: checkin.allCategories, exact: true })).toHaveAttribute('aria-selected', 'true');
      const records = await page.locator('.checkin-records-panel').boundingBox();
      const sidebar = await page.locator('.checkin-sidebar').boundingBox();
      const tasks = await page.locator('.checkin-tasks-panel').boundingBox();
      expect(tasks!.y - (records!.y + records!.height)).toBeLessThanOrEqual(25);
      if (testInfo.project.name === 'desktop-chromium') expect(sidebar!.x).toBeGreaterThan(records!.x + records!.width);
      else expect(sidebar!.y).toBeGreaterThan(tasks!.y + tasks!.height);
    }
    await audit(page, route);
    if (process.env.ISLAND_CAPTURE_PREVIEWS) await page.screenshot({ path: `.local/previews/${route}-layout-${testInfo.project.name}.png`, fullPage: false });
  }
  await navigation.getByRole('button', { name: content.navigation.camp, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.achievements, exact: true }).click();
  await expect(page.locator('.achievement-grid')).toBeVisible();
  await audit(page, 'achievements');
  const opener = page.getByRole('button', { name: content.navigation.management, exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByRole('button', { name: content.common.close, exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(content.account.managementPassword, { exact: true })).toBeFocused();
  expect(await page.evaluate(() => { const element = document.activeElement; return element && element.matches(':focus-visible') && parseFloat(getComputedStyle(element).outlineWidth) >= 3; })).toBe(true);
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
});

// 在桌面和 iPhone 14 视口验证同一管理导航、字号与账户排列。
test('管理工作区紧凑布局、七个页签和键盘切换', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();

  const sections = [
    { name: content.navigation.account, ready: page.getByLabel(content.account.displayName, { exact: true }) },
    { name: content.navigation.categories, ready: page.getByRole('button', { name: checkin.newCategory, exact: true }) },
    { name: content.navigation.tasks, ready: page.getByRole('button', { name: checkin.newTask, exact: true }) },
    { name: content.navigation.records, ready: page.getByLabel(checkin.date, { exact: true }) },
    { name: content.navigation.products, ready: page.getByRole('tab', { name: shop.productLibrary, exact: true }) },
    { name: content.navigation.achievementManagement, ready: page.getByRole('button', { name: achievement.new, exact: true }) },
    { name: family.sounds, ready: page.getByLabel(family.music, { exact: true }) },
  ];
  const management = page.getByRole('tablist', { name: content.navigation.management, exact: true });
  await expect(management.getByRole('tab')).toHaveText(sections.map((section) => section.name));
  const account = management.getByRole('tab', { name: content.navigation.account, exact: true });
  await expect(account).toHaveAttribute('aria-selected', 'true');
  await account.focus();
  await account.press('End');
  const sound = management.getByRole('tab', { name: family.sounds, exact: true });
  await expect(sound).toBeFocused();
  await expect(sound).toHaveAttribute('aria-selected', 'true');
  await sound.press('Home');
  await expect(account).toBeFocused();
  await expect(account).toHaveAttribute('aria-selected', 'true');

  const login = await page.getByRole('region', { name: content.account.loginPasswordTitle, exact: true }).boundingBox();
  const password = await page.getByRole('region', { name: content.account.managementPasswordTitle, exact: true }).boundingBox();
  expect(login).not.toBeNull();
  expect(password).not.toBeNull();
  if (testInfo.project.name === 'desktop-chromium') expect(password!.x).toBeGreaterThan(login!.x);
  else expect(password!.y).toBeGreaterThan(login!.y);

  for (const { name, ready } of sections) {
    const tab = management.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByRole('tabpanel', { name, exact: true });
    await expect(panel).toBeVisible();
    await expect(ready).toBeVisible();
    await expect(panel.getByRole('heading', { name, exact: true })).toHaveCount(0);
    if (process.env.ISLAND_CAPTURE_PREVIEWS && [content.navigation.account, content.navigation.products].includes(name)) {
      if (name === content.navigation.products) {
        const artwork = panel.locator('.shop-management-card img').first();
        await artwork.scrollIntoViewIfNeeded();
        await expect.poll(() => artwork.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      }
      await page.screenshot({ path: testInfo.outputPath(`management-${name}.png`), fullPage: name === content.navigation.account });
    }
    await audit(page, name, 14, 44);
  }
});
