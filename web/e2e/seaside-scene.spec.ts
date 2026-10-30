import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import island from '../src/features/island/content.json' with { type: 'json' };
import { openMotionIsland } from './island-motion-fixtures';
import { setObjectPageVisibility } from './island-object-motion-fixtures';

// 逐帧测量浏览器实际计算的姿势和时间，暂停属性本身不足以证明动画已冻结。
async function sampleAmbient(page: Page, frames = 20) {
  return page.evaluate(async (count) => {
    const selectors = ['.seaside-water-ripples', '.seaside-shore-wave', '.scene-cloud-drift'];
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await frame();
    await frame();
    const rows = selectors.map((selector) => {
      const element = document.querySelector(selector)!;
      return {
        selector, element, poses: new Set([getComputedStyle(element).transform]),
        firstTime: Number(element.getAnimations()[0]?.currentTime ?? 0),
      };
    });
    for (let index = 0; index < count; index += 1) {
      await frame();
      for (const row of rows) row.poses.add(getComputedStyle(row.element).transform);
    }
    return rows.map(({ selector, element, poses, firstTime }) => ({
      selector, poses: poses.size, firstTime,
      lastTime: Number(element.getAnimations()[0]?.currentTime ?? 0),
      animationCount: element.getAnimations().length,
      playState: element.getAnimations()[0]?.playState ?? null,
    }));
  }, frames);
}

test('海水、岸浪与云持续运动，暂停及模拟隐藏保留相位，恢复继续播放', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openMotionIsland(page);
  for (const sample of await sampleAmbient(page)) {
    expect(sample.poses, sample.selector).toBeGreaterThan(4);
    expect(sample.lastTime, sample.selector).toBeGreaterThan(sample.firstTime);
  }
  await page.getByRole('button', { name: island.pause, exact: true }).click();
  const paused = await sampleAmbient(page);
  for (const sample of paused) {
    expect(sample.poses, sample.selector).toBe(1);
    expect(sample.playState, sample.selector).toBe('paused');
    expect(sample.lastTime, sample.selector).toBeCloseTo(sample.firstTime, 3);
  }
  await page.getByRole('button', { name: island.resume, exact: true }).click();
  for (const [index, sample] of (await sampleAmbient(page)).entries()) {
    expect(sample.poses, sample.selector).toBeGreaterThan(4);
    expect(sample.firstTime, sample.selector).toBeGreaterThanOrEqual(paused[index]!.lastTime);
  }
  // 模拟 visibilitychange 只证明页面控制生效，不声明操作系统真实后台已验收。
  await setObjectPageVisibility(page, 'hidden');
  for (const sample of await sampleAmbient(page)) {
    expect(sample.poses, sample.selector).toBe(1);
    expect(sample.lastTime, sample.selector).toBeCloseTo(sample.firstTime, 3);
  }
  await setObjectPageVisibility(page, 'visible');
  for (const sample of await sampleAmbient(page)) expect(sample.poses, sample.selector).toBeGreaterThan(4);
});

test('布置和系统减少动效停用环境动画，并保留草坪、沙滩、海水与云', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openMotionIsland(page);
  await page.getByRole('button', { name: island.edit, exact: true }).click();
  for (const sample of await sampleAmbient(page, 10)) {
    expect(sample.animationCount, sample.selector).toBe(0);
    expect(sample.poses, sample.selector).toBe(1);
  }
  await page.getByRole('button', { name: island.cancel, exact: true }).click();
  for (const sample of await sampleAmbient(page, 10)) expect(sample.lastTime, sample.selector).toBeGreaterThan(sample.firstTime);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const sample of await sampleAmbient(page, 10)) {
    expect(sample.animationCount, sample.selector).toBe(0);
    expect(sample.poses, sample.selector).toBe(1);
  }
  for (const kind of ['grass', 'sand', 'water']) await expect(page.locator(`[data-terrain="${kind}"]`)).toHaveCount(1);
  await expect(page.locator('.scene-cloud-drift')).toHaveCount(4);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const sample of await sampleAmbient(page, 10)) expect(sample.poses, sample.selector).toBeGreaterThan(1);
});

test('地面平移不带动天空，复位恢复构图，并记录桌面平板手机画面', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMotionIsland(page);
  const scene = page.locator('.island-scene');
  const originalPan = await scene.getAttribute('data-pan-x');
  const skyTransform = await page.locator('.scene-sky').evaluate((element) => (element as SVGGraphicsElement).getScreenCTM()!.toString());
  await scene.focus();
  await page.keyboard.press('ArrowRight');
  await expect(scene).not.toHaveAttribute('data-pan-x', originalPan!);
  expect(await page.locator('.scene-sky').evaluate((element) => (element as SVGGraphicsElement).getScreenCTM()!.toString())).toBe(skyTransform);
  await page.getByRole('button', { name: island.resetView, exact: true }).click();
  await expect(scene).toHaveAttribute('data-pan-x', originalPan!);
  await mkdir('.local/previews', { recursive: true });
  const sizes = testInfo.project.use.isMobile ? [{ width: 390, height: 844 }] : [{ width: 1440, height: 900 }, { width: 768, height: 1024 }];
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.getByRole('button', { name: island.resetView, exact: true }).click();
    await expect(scene).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // 在实际绘制的 SVG 上取样，排除天空和浮层，不用配置中的目标比例代替画面。
    await expect.poll(() => page.evaluate(() => {
      const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const header = bounds('.island-page-header');
      const tasks = bounds('.island-checkin-panel');
      const sky = bounds('.scene-sky > rect');
      const top = Math.max(sky.bottom, header.bottom + 12, innerWidth <= 700 ? tasks.bottom + 12 : 0);
      const bottom = bounds('.island-game-dock').top - 12;
      const left = innerWidth > 1050 ? tasks.right + 12 : 12;
      const paths = [...document.querySelectorAll<SVGGeometryElement>('[data-terrain]')];
      const svg = document.querySelector<SVGSVGElement>('.island-scene')!;
      let land = 0;
      for (let row = 0; row < 30; row += 1) for (let column = 0; column < 30; column += 1) {
        const point = svg.createSVGPoint();
        point.x = left + (innerWidth - 12 - left) * (column + .5) / 30;
        point.y = top + (bottom - top) * (row + .5) / 30;
        if (paths.some((path) => path.dataset.terrain !== 'water' && path.isPointInFill(point.matrixTransform(path.getScreenCTM()!.inverse())))) land += 1;
      }
      return land / 900;
    })).toBeCloseTo(.6, 1);
    const path = `.local/previews/seaside-${testInfo.project.name}-${size.width}.png`;
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`海边场景 ${size.width}`, { path, contentType: 'image/png' });
  }
});
