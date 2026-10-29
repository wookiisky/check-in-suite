import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { testSession } from '../src/test/account-fixtures';
import { camp, purchase } from '../src/features/shop/test-fixtures';
import { state } from '../src/features/island/island-test-fixtures';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import island from '../src/features/island/content.json' with { type: 'json' };

// 只替换接口数据，运动、SVG、CSS 和交互仍运行正式页面代码。
export async function openMotionIsland(page: Page, avatar?: string) {
  const human = avatar === 'avatar-boy-v2' || avatar === 'avatar-girl-v2';
  const equippedCamp = { ...camp, equipment: { ...camp.equipment,
    ...(human ? { base_avatar_key: avatar, avatar: null } : { avatar: { ...purchase, type_snapshot: 'avatar' as const, asset_key_snapshot: avatar ?? 'fox-v1' } }),
  } };
  const activityState = avatar ? {
    ...state,
    catalog: [...state.catalog, { key: 'ball', name: '皮球', category: 'equipment', model: 'ball', width: 1, depth: 1, movable: true, repeatable: false, activity: 'ball' }],
    inventory: [...state.inventory, { id: 'test:ball', item_key: 'ball' }],
    placements: [...state.placements, { id: 'test:ball', item_key: 'ball', x: 5, y: 5, rotation: 0, zone: 'outdoor' }],
  } : state;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (path.startsWith('/assets/')) {
      const key = path.slice('/assets/'.length);
      const body = await readFile(new URL(`../../internal/assets/builtin/${key}.svg`, import.meta.url));
      await route.fulfill({ contentType: 'image/svg+xml', body });
      return;
    }
    const responses: Record<string, unknown> = {
      '/session': testSession, '/camp': equippedCamp, '/island': activityState,
      '/checkins': { items: [], next_cursor: null }, '/messages': { items: [], next_cursor: null },
    };
    expect(path in responses, `未模拟的接口：${path}`).toBeTruthy();
    await route.fulfill({ json: responses[path] });
  });
  await page.goto('/');
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  await expect(page.getByRole('group', { name: island.scene, exact: true })).toBeVisible();
}

// 逐帧读取最终变换矩阵；动画实例可以重建，但运动姿势必须连续。
export async function sampleMotion(page: Page, frames = 180) {
  return page.evaluate(async (count) => {
    const actor = document.querySelector<SVGGElement>('[data-actor-zone]')!;
    const head = actor.querySelector('.island-character-head')!;
    const leg = actor.querySelector('.island-character-leg-left')!;
    const headMatrix = new DOMMatrix(getComputedStyle(head).transform);
    let previousAngle = Math.atan2(headMatrix.b, headMatrix.a) * 180 / Math.PI;
    let previousY = headMatrix.f;
    // 首次取样尚无前一帧时间，不能把调用发生到下一帧的间隔当成完整动画帧。
    let previousFrame: number | null = null;
    let previousZone = actor.getAttribute('data-actor-zone');
    let minimumLegAngle = Infinity, maximumLegAngle = -Infinity;
    let animation = head.getAnimations()[0];
    let previousTime = Number(animation?.currentTime ?? 0);
    let previousPosition = actor.getAttribute('transform');
    let previousSibling = actor.previousElementSibling;
    let previousAction = actor.getAttribute('data-actor-action');
    let movingFrames = 0, positionChanges = 0, animationResets = 0, reorderedFrames = 0, nodeReplacements = 0, zoneChanges = 0;
    const resets: { before: number; after: number; reordered: boolean }[] = [];
    const poseJumps: { angle: number; y: number; milliseconds: number; reordered: boolean; zoneChanged: boolean }[] = [];
    for (let frame = 0; frame < count; frame += 1) {
      const timestamp = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
      const current = document.querySelector<SVGGElement>('[data-actor-zone]')!;
      if (current !== actor) nodeReplacements += 1;
      const currentAnimation = head.getAnimations()[0];
      const time = Number(currentAnimation?.currentTime ?? 0);
      if (currentAnimation !== animation || time + 1 < previousTime) {
        animationResets += 1;
        resets.push({ before: previousTime, after: time, reordered: current.previousElementSibling !== previousSibling });
      }
      if (current.previousElementSibling !== previousSibling) reorderedFrames += 1;
      const position = current.getAttribute('transform');
      const action = current.getAttribute('data-actor-action');
      const zone = current.getAttribute('data-actor-zone');
      if (zone !== previousZone) zoneChanges += 1;
      const matrix = new DOMMatrix(getComputedStyle(head).transform);
      const angle = Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
      if (action === 'walk' && previousAction === 'walk') {
        movingFrames += 1;
        if (position !== previousPosition) positionChanges += 1;
        const legMatrix = new DOMMatrix(getComputedStyle(leg).transform);
        const legAngle = Math.atan2(legMatrix.b, legMatrix.a) * 180 / Math.PI;
        minimumLegAngle = Math.min(minimumLegAngle, legAngle);
        maximumLegAngle = Math.max(maximumLegAngle, legAngle);
        const milliseconds = previousFrame === null ? null : Math.max(0, timestamp - previousFrame);
        // 呼吸动作在两秒内转动两度、抬高一像素；上限给缓动和矩阵精度留余量。
        const angleChange = Math.abs(angle - previousAngle), yChange = Math.abs(matrix.f - previousY);
        if (milliseconds !== null && (angleChange > milliseconds * 0.003 + 0.03 || yChange > milliseconds * 0.002 + 0.03)) {
          poseJumps.push({ angle: angleChange, y: yChange, milliseconds,
            reordered: current.previousElementSibling !== previousSibling, zoneChanged: zone !== previousZone });
        }
      }
      animation = currentAnimation; previousTime = time; previousPosition = position;
      previousSibling = current.previousElementSibling; previousAction = action;
      previousAngle = angle; previousY = matrix.f; previousFrame = timestamp; previousZone = zone;
    }
    return { movingFrames, positionChanges, animationResets, reorderedFrames, nodeReplacements, resets,
      poseJumps, zoneChanges, legAngleRange: maximumLegAngle - minimumLegAngle };
  }, frames);
}

// 到达后采样多帧的真实绘制姿势，避免周期动作恰好在同一姿势时误判。
export async function sampleActivityPose(page: Page, selectors: string[], frames = 30) {
  return page.evaluate(async ({ selectors, frames }) => {
    const actor = document.querySelector<SVGGElement>('[data-actor-zone]')!;
    const positions = new Set<string>();
    const poses = selectors.map(() => new Set<string>());
    for (let frame = 0; frame < frames; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      positions.add(actor.getAttribute('transform')!);
      selectors.forEach((selector, index) => {
        const part = actor.querySelector(selector);
        poses[index]!.add(part ? getComputedStyle(part).transform : 'missing');
      });
    }
    return { positions: positions.size, parts: selectors.map((selector, index) => ({ selector, poses: [...poses[index]!] })) };
  }, { selectors, frames });
}
