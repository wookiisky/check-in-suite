import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import island from '../src/features/island/content.json' with { type: 'json' };
import { openObjectMotionIsland, sampleObjectMotion, setObjectPageVisibility } from './island-object-motion-fixtures';

test('五类物件的局部动作持续变化，底座固定且镜像实例独立展示', async ({ page }, testInfo) => {
  await openObjectMotionIsland(page);
  const samples = await sampleObjectMotion(page, 75);
  for (const sample of samples) {
    expect(sample.changes, sample.id).toBeGreaterThan(20);
    if (sample.baseTracked) expect(sample.baseChanges, sample.id).toBe(0);
    expect(sample.lastTime, sample.id).toBeGreaterThan(sample.firstTime);
  }
  const normal = page.locator('[data-placement-id="motion:windmill"] .island-item-art > g');
  const mirror = page.locator('[data-placement-id="motion:windmill-mirror"] .island-item-art > g');
  await expect(normal).toHaveAttribute('transform', 'scale(1 1)');
  await expect(mirror).toHaveAttribute('transform', 'scale(-1 1)');
  expect(await page.locator('.island-scene .island-object-art').evaluateAll((objects) => {
    const ids = objects.flatMap((object) => [...object.querySelectorAll('[id]')].map((element) => element.id));
    return new Set(ids).size === ids.length;
  })).toBe(true);
  const statistics = testInfo.outputPath('object-motion-statistics.json');
  await writeFile(statistics, JSON.stringify(samples, null, 2));
  await testInfo.attach('物件动画帧统计', { path: statistics, contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('island-object-motion.png') });
});

test('暂停和页面隐藏冻结物件相位，恢复后继续，布置显示静态画面', async ({ page }) => {
  await openObjectMotionIsland(page);
  await sampleObjectMotion(page, 12);
  await page.getByRole('button', { name: island.pause, exact: true }).click();
  await expect(page.locator('.island-scene .island-item-art').first()).toHaveAttribute('data-paused', 'true');
  const paused = await sampleObjectMotion(page, 20);
  for (const sample of paused) {
    expect(sample.changes, sample.id).toBe(0);
    expect(sample.lastTime, sample.id).toBeCloseTo(sample.firstTime, 3);
    expect(sample.playState, sample.id).toBe('paused');
  }
  await page.getByRole('button', { name: island.resume, exact: true }).click();
  for (const [index, sample] of (await sampleObjectMotion(page, 15)).entries()) {
    expect(sample.firstTime, sample.id).toBeGreaterThanOrEqual(paused[index]!.lastTime);
    expect(sample.firstTime - paused[index]!.lastTime, sample.id).toBeLessThan(100);
    expect(sample.lastTime, sample.id).toBeGreaterThan(sample.firstTime);
  }
  await setObjectPageVisibility(page, 'hidden');
  await expect(page.locator('.island-scene .island-item-art').first()).toHaveAttribute('data-paused', 'true');
  const hidden = await sampleObjectMotion(page, 20);
  for (const sample of hidden) {
    expect(sample.changes, sample.id).toBe(0);
    expect(sample.lastTime, sample.id).toBeCloseTo(sample.firstTime, 3);
  }
  await setObjectPageVisibility(page, 'visible');
  const resumed = await sampleObjectMotion(page, 12);
  for (const [index, sample] of resumed.entries()) {
    expect(sample.firstTime, sample.id).toBeGreaterThanOrEqual(hidden[index]!.lastTime);
    expect(sample.firstTime - hidden[index]!.lastTime, sample.id).toBeLessThan(100);
    expect(sample.lastTime, sample.id).toBeGreaterThan(sample.firstTime);
  }
  await page.getByRole('button', { name: island.edit, exact: true }).click();
  await expect(page.locator('.island-scene .island-item-art').first()).toHaveAttribute('data-static', 'true');
  for (const sample of await sampleObjectMotion(page, 15)) {
    expect(sample.animationCount, sample.id).toBe(0);
    expect(sample.changes, sample.id).toBe(0);
  }
  await page.getByRole('button', { name: island.cancel, exact: true }).click();
  for (const sample of await sampleObjectMotion(page, 15)) expect(sample.lastTime, sample.id).toBeGreaterThan(sample.firstTime);
});

test('系统减少动效可即时切换，五类物件保留完整静态内容', async ({ page }) => {
  await openObjectMotionIsland(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.island-scene .island-item-art').first()).toHaveAttribute('data-static', 'true');
  for (const sample of await sampleObjectMotion(page, 15)) {
    expect(sample.animationCount, sample.id).toBe(0);
    expect(sample.changes, sample.id).toBe(0);
  }
  await expect(page.locator('.island-scene .island-object-base')).toHaveCount(6);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const sample of await sampleObjectMotion(page, 15)) expect(sample.lastTime, sample.id).toBeGreaterThan(sample.firstTime);
});

test('账户减少动效在系统正常时仍停用全部物件动画', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openObjectMotionIsland(page, true);
  await expect(page.locator('.island-scene .island-item-art').first()).toHaveAttribute('data-static', 'true');
  for (const sample of await sampleObjectMotion(page, 15)) {
    expect(sample.animationCount, sample.id).toBe(0);
    expect(sample.changes, sample.id).toBe(0);
  }
  await expect(page.locator('.island-scene .island-object-art')).toHaveCount(6);
});
