import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import island from '../src/features/island/content.json' with { type: 'json' };
import { openMotionIsland, sampleMotion, sampleActivityPose } from './island-motion-fixtures';

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

for (const avatar of ['fox-v1', 'bunny-v1', 'avatar-boy-v2']) {
  test(`${avatar} 点击物件到达后持续运动、玩球和阅读`, async ({ page }, testInfo) => {
    test.setTimeout(60000);
    await openMotionIsland(page, avatar);
    const actor = page.locator('[data-actor-zone]');
    const activities = page.getByRole('region', { name: island.activitiesTitle });
    const image = avatar.startsWith('avatar-');
    // 直接点场景物件，覆盖指针捕获和随后的 click，而非只调用活动按钮。
    await page.locator('[data-placement-id="base:run"]').click();
    await expect(actor).toHaveAttribute('data-actor-action', 'run', { timeout: 15000 });
    const runningParts = image ? ['.island-character-image-body'] : [
      '.island-character-body', '.island-character-leg-left', '.island-character-leg-right',
      '.island-character-arm-left', '.island-character-arm-right',
    ];
    const running = await sampleActivityPose(page, runningParts);
    expect(running.positions).toBe(1);
    for (const part of running.parts) expect(part.poses.length, `${avatar} 跑步 ${part.selector}`).toBeGreaterThan(1);
    // 图片角色到站后也必须受相同暂停时钟控制。
    if (image) {
      await page.getByRole('button', { name: island.pause, exact: true }).click();
      const paused = await sampleActivityPose(page, runningParts);
      expect(paused.positions).toBe(1);
      expect(paused.parts[0]!.poses).toHaveLength(1);
      await page.getByRole('button', { name: island.resume, exact: true }).click();
      expect((await sampleActivityPose(page, runningParts)).parts[0]!.poses.length).toBeGreaterThan(1);
      await page.locator('[data-placement-id="base:run"]').click();
      await expect(actor).toHaveAttribute('data-actor-action', 'run');
      expect((await sampleActivityPose(page, runningParts)).parts[0]!.poses.length).toBeGreaterThan(1);
      await page.screenshot({ path: testInfo.outputPath(`${avatar}-running.png`) });
    }
    await activities.getByRole('button', { name: '玩球 皮球' }).click();
    await expect(actor).toHaveAttribute('data-actor-action', 'ball', { timeout: 15000 });
    await expect(actor.locator('.island-character-ball')).toBeVisible();
    const ball = await sampleActivityPose(page, image ? ['.island-character-image-body', '.island-character-ball'] : ['.island-character-leg-right', '.island-character-ball']);
    expect(ball.positions).toBe(1);
    for (const part of ball.parts) expect(part.poses.length, `${avatar} 玩球 ${part.selector}`).toBeGreaterThan(1);
    if (image) await page.screenshot({ path: testInfo.outputPath(`${avatar}-ball.png`) });
    await activities.getByRole('button', { name: '读书 书桌' }).click();
    await expect(actor).toHaveAttribute('data-actor-action', 'read', { timeout: 15000 });
    await expect(actor.locator('.island-character-book')).toBeVisible();
    const reading = await sampleActivityPose(page, [image ? '.island-character-image-body' : '.island-character-head']);
    expect(reading.positions).toBe(1);
    expect(reading.parts[0]!.poses.length).toBeGreaterThan(1);
    await page.screenshot({ path: testInfo.outputPath(`${avatar}-reading.png`) });
  });
}

test('图片角色减少动效时保留阅读与玩球的静态反馈', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMotionIsland(page, 'avatar-girl-v2');
  const actor = page.locator('[data-actor-zone]');
  const activities = page.getByRole('region', { name: island.activitiesTitle });
  for (const activity of [
    { label: '读书 书桌', action: 'read', prop: '.island-character-book' },
    { label: '玩球 皮球', action: 'ball', prop: '.island-character-ball' },
  ]) {
    await activities.getByRole('button', { name: activity.label }).click();
    await expect(actor).toHaveAttribute('data-actor-action', activity.action);
    await expect(actor.locator(activity.prop)).toBeVisible();
    const pose = await sampleActivityPose(page, ['.island-character-image-body', activity.prop]);
    expect(pose.positions).toBe(1);
    for (const part of pose.parts) expect(part.poses).toHaveLength(1);
  }
});
