import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { IslandDefinition, IslandPlacement, IslandState } from '../src/features/island/island-types';
import { testSession } from '../src/test/account-fixtures';
import { camp } from '../src/features/shop/test-fixtures';
import { state } from '../src/features/island/island-test-fixtures';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import island from '../src/features/island/content.json' with { type: 'json' };

// 每个断言指向实际运动部件；同时观察同一物件的固定底座。
export const objectMotionTargets = [
  { id: 'motion:windmill', part: '.island-windmill-blades' },
  { id: 'motion:windmill-mirror', part: '.island-windmill-blades' },
  { id: 'motion:fountain', part: '.island-fountain-water' },
  { id: 'motion:fountain', part: '.island-fountain-ripple' },
  { id: 'motion:swing', part: '.island-swing-seat' },
  { id: 'motion:lantern', part: '.island-lantern-flame' },
  { id: 'motion:lantern', part: '.island-lantern-glow' },
  { id: 'motion:flowers', part: '.island-flowers-stems' },
  { id: 'motion:tree', part: '.island-tree-crown' },
  { id: 'motion:butterfly', part: '.island-butterfly-wings' },
];

// 预览场景不保存布局，只模拟读取响应；目录能力来自正式资源文件。
export async function openObjectMotionIsland(page: Page, reduceMotion = false) {
  const catalog = JSON.parse(await readFile(new URL('../../internal/island/catalog.json', import.meta.url), 'utf8')) as IslandDefinition[];
  const placements: IslandPlacement[] = [
    { id: 'base:environment', item_key: 'day', x: 0, y: 0, rotation: 0, zone: 'outdoor' },
    { id: 'motion:windmill', item_key: 'windmill', x: -4, y: -4, rotation: 0, zone: 'outdoor' },
    { id: 'motion:windmill-mirror', item_key: 'windmill', x: 0, y: -4, rotation: 180, zone: 'outdoor' },
    { id: 'motion:fountain', item_key: 'fountain', x: 4, y: -4, rotation: 0, zone: 'outdoor' },
    { id: 'motion:swing', item_key: 'swing', x: -4, y: 2, rotation: 0, zone: 'outdoor' },
    { id: 'motion:lantern', item_key: 'lantern', x: 0, y: 2, rotation: 0, zone: 'outdoor' },
    { id: 'motion:flowers', item_key: 'flowers', x: 4, y: 2, rotation: 0, zone: 'outdoor' },
    { id: 'motion:tree', item_key: 'tree', x: -2, y: 6, rotation: 0, zone: 'outdoor' },
    { id: 'motion:butterfly', item_key: 'butterfly', x: 3, y: 6, rotation: 0, zone: 'outdoor' },
  ];
  const preview: IslandState = {
    ...state, catalog, placements,
    inventory: placements.map(({ id, item_key }) => ({ id, item_key })),
  };
  const account = { ...testSession.account, preferences: { ...testSession.account.preferences, reduce_motion: reduceMotion } };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (path.startsWith('/assets/')) {
      const key = path.slice('/assets/'.length);
      await route.fulfill({ contentType: 'image/svg+xml', body: await readFile(new URL(`../../internal/assets/builtin/${key}.svg`, import.meta.url)) });
      return;
    }
    const responses: Record<string, unknown> = {
      '/session': { ...testSession, account }, '/camp': { ...camp, account }, '/island': preview,
      '/checkins': { items: [], next_cursor: null }, '/messages': { items: [], next_cursor: null },
    };
    expect(route.request().method()).toBe('GET');
    expect(path in responses, `未模拟的接口：${path}`).toBeTruthy();
    await route.fulfill({ json: responses[path] });
  });
  await page.goto('/');
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  await expect(page.getByRole('group', { name: island.scene, exact: true })).toBeVisible();
  await expect(page.locator('.island-scene .island-object-art')).toHaveCount(6);
}

// 同一次采样逐帧读取部件姿态、时间和底座矩阵，避免只检查 CSS 声明。
export async function sampleObjectMotion(page: Page, frames = 60) {
  return page.evaluate(async ({ targets, count }) => {
    // CSS 的播放与暂停会等待浏览器提交；ready 完成后再取基线，仍要求冻结期间零变化。
    const animations = targets.flatMap(({ id, part }) =>
      document.querySelector(`[data-placement-id="${id}"]`)!.querySelector(part)!.getAnimations());
    await Promise.all(animations.map((animation) => animation.ready));
    const rows = targets.map(({ id, part }) => {
      const object = document.querySelector(`[data-placement-id="${id}"]`)!;
      const moving = object.querySelector<SVGGraphicsElement>(part)!;
      // 原蝴蝶的漂浮组包含阴影，因此只对它验证翅膀与暂停，不声明底座固定。
      const base = id === 'motion:butterfly' ? null : object.querySelector<SVGGraphicsElement>('.island-object-base, ellipse')!;
      const pose = () => {
        const style = getComputedStyle(moving);
        return `${style.transform}/${style.opacity}`;
      };
      const basePose = () => {
        const matrix = base?.getCTM();
        if (!matrix) return '';
        return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].map((value) => value.toFixed(4)).join('/');
      };
      return { id: `${id} ${part}`, moving, pose, basePose, baseTracked: base !== null, previousPose: pose(), initialBase: basePose(),
        firstTime: Number(moving.getAnimations()[0]?.currentTime ?? 0), changes: 0, baseChanges: 0 };
    });
    for (let frame = 0; frame < count; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      for (const row of rows) {
        const next = row.pose();
        if (next !== row.previousPose) row.changes += 1;
        if (row.basePose() !== row.initialBase) row.baseChanges += 1;
        row.previousPose = next;
      }
    }
    return rows.map(({ id, moving, firstTime, changes, baseChanges, baseTracked }) => ({
      id, changes, baseChanges, baseTracked, firstTime,
      lastTime: Number(moving.getAnimations()[0]?.currentTime ?? 0),
      animationCount: moving.getAnimations().length,
      playState: moving.getAnimations()[0]?.playState ?? null,
    }));
  }, { targets: objectMotionTargets, count: frames });
}

// 通过可见性事件验证页面控制；这不代替操作系统真实后台标签页的验收。
export async function setObjectPageVisibility(page: Page, visibility: DocumentVisibilityState) {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visibility);
}
