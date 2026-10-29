import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { testSession } from '../src/test/account-fixtures';
import { camp } from '../src/features/shop/test-fixtures';
import { state } from '../src/features/island/island-test-fixtures';
import type { IslandState } from '../src/features/island/island-types';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import island from '../src/features/island/content.json' with { type: 'json' };

// 多件球放在房屋与运动区以外，末项仍使用实际可达的运动区。
export function activityListState(count: number): IslandState {
  const balls = Array.from({ length: Math.max(0, count - 2) }, (_, index) => ({
    id: `activity-ball-${index}`, item_key: 'activity-ball', x: index < 6 ? 6 : -6,
    y: index < 6 ? -6 + index * 2 : 4, rotation: 0 as const, zone: 'outdoor' as const,
  }));
  const activities = count ? [state.placements[1]!, ...balls, state.placements[2]!] : [];
  return {
    ...state,
    catalog: [...state.catalog, { key: 'activity-ball', name: '活动皮球', category: 'equipment', model: 'ball',
      width: 1, depth: 1, movable: true, repeatable: true, activity: 'ball' }],
    inventory: [...state.inventory, ...balls.map(({ id, item_key }) => ({ id, item_key }))],
    placements: [...state.placements.filter((item) => !['desk', 'run'].includes(item.item_key)), ...activities],
  };
}

// 接口替身只控制活动数量，布局、滚动与活动执行使用正式组件。
export async function openActivityList(page: Page, count = 9) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (path.startsWith('/assets/')) {
      const key = path.slice('/assets/'.length);
      const body = await readFile(new URL(`../../internal/assets/builtin/${key}.svg`, import.meta.url));
      await route.fulfill({ contentType: 'image/svg+xml', body });
      return;
    }
    const responses: Record<string, unknown> = {
      '/session': testSession, '/camp': camp, '/island': activityListState(count),
      '/checkins': { items: [], next_cursor: null }, '/messages': { items: [], next_cursor: null },
    };
    expect(path in responses, `未模拟的接口：${path}`).toBeTruthy();
    await route.fulfill({ json: responses[path] });
  });
  await page.goto('/');
  await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
  await expect(page.getByRole('group', { name: island.scene, exact: true })).toBeVisible();
}
