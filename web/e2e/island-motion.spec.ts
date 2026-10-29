import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import island from '../src/features/island/content.json' with { type: 'json' };
import { openMotionIsland, sampleMotion } from './island-motion-fixtures';

test('角色随绘制帧连续移动，经过物体前后保持肢体姿势连续', async ({ page }, testInfo) => {
  await openMotionIsland(page);
  await page.getByRole('region', { name: island.activitiesTitle }).getByRole('button', { name: '跑步 运动区' }).click();
  const sample = await sampleMotion(page);
  const statisticsPath = testInfo.outputPath('motion-statistics.json');
  await writeFile(statisticsPath, JSON.stringify(sample, null, 2));
  await testInfo.attach('运动帧统计', { path: statisticsPath, contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('island-motion.png') });
  expect(sample.movingFrames).toBeGreaterThan(20);
  expect(sample.positionChanges / sample.movingFrames).toBeGreaterThan(0.7);
  expect(sample.reorderedFrames).toBeGreaterThan(0);
  expect(sample.nodeReplacements).toBe(0);
  expect(sample.legAngleRange).toBeGreaterThan(10);
  expect(sample.poseJumps).toEqual([]);
  await expect(page.locator('[data-actor-zone]')).toHaveAttribute('data-actor-action', 'run');
});

test('暂停恢复不跨越路径，进出房屋仍在同一场景切换', async ({ page }) => {
  await openMotionIsland(page);
  const actor = page.locator('[data-actor-zone]');
  const activities = page.getByRole('region', { name: island.activitiesTitle });
  await activities.getByRole('button', { name: '读书 书桌' }).click();
  await expect(actor).toHaveAttribute('data-actor-action', 'walk');
  await page.getByRole('button', { name: island.pause, exact: true }).click();
  const paused = await actor.getAttribute('transform');
  await sampleMotion(page, 30);
  await expect(actor).toHaveAttribute('transform', paused!);
  await page.getByRole('button', { name: island.resume, exact: true }).click();
  const entrance = await sampleMotion(page, 300);
  expect(entrance.zoneChanges).toBe(1);
  expect(entrance.poseJumps).toEqual([]);
  await expect(actor).toHaveAttribute('data-actor-zone', 'indoor', { timeout: 15000 });
  await expect(page.locator('[data-placement-id="base:house"]')).toHaveAttribute('data-house-open', 'true');
  await expect(actor).toHaveAttribute('data-actor-action', 'read', { timeout: 15000 });
  await activities.getByRole('button', { name: '跑步 运动区' }).click();
  await expect(actor).toHaveAttribute('data-actor-zone', 'outdoor', { timeout: 15000 });
  await expect(page.locator('[data-placement-id="base:house"]')).toHaveAttribute('data-house-open', 'false');
  await expect(actor).toHaveAttribute('data-actor-action', 'run', { timeout: 15000 });
});
