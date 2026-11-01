import { test as base, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/features/island/three/spatial-content.json' with { type: 'json' };
import { appearanceAPI, openCharacterPreview } from './appearance-flow-fixtures';

export type SpatialState = components['schemas']['SpatialIslandState'];

// 保存契约只包含布局值，目录、库存和相机不会被写回。
export function spatialRequest(state: SpatialState) {
  return { expected_version: state.version, scene_key: state.scene_key, environment_key: state.environment_key, placements: state.placements };
}

// 读取真实会话授权下的布局，不从 Canvas 或提示文案推断保存结果。
export async function readSpatial(page: Page): Promise<SpatialState> {
  const response = await appearanceAPI(page, '/island/layout');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<SpatialState>;
}

// 每条流程都从正式登录开始，结束时按最新版本恢复同一账户的原布局。
export const test = base.extend<{ originalLayout: SpatialState }>({
  originalLayout: async ({ page }, use) => {
    await openCharacterPreview(page);
    const original = await readSpatial(page);
    try { await use(original); }
    finally {
      const current = await readSpatial(page);
      const { expected_version: _originalVersion, ...originalValues } = spatialRequest(original);
      const { expected_version: _currentVersion, ...currentValues } = spatialRequest(current);
      if (JSON.stringify(originalValues) !== JSON.stringify(currentValues)) {
        const restored = await appearanceAPI(page, '/island/layout', 'PUT', { ...originalValues, expected_version: current.version });
        expect(restored.ok()).toBe(true);
      }
    }
  },
});

// 等待页面实际读取布局和独立活动资格，两个接口不能互相替代。
export async function openIsland3D(page: Page) {
  const layout = page.waitForResponse((response) => response.url().endsWith('/api/v1/island/layout') && response.request().method() === 'GET');
  const access = page.waitForResponse((response) => response.url().endsWith('/api/v1/island/activity-access'));
  await page.goto('/island-3d.html');
  expect((await layout).ok()).toBe(true);
  expect((await access).ok()).toBe(true);
  await expect(page.getByRole('button', { name: content.edit, exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: content.scene, exact: true }).locator('canvas')).toBeVisible();
}

// 目录提供可访问名称，基础主屋的显示名称不写死在测试中。
export async function selectHouse(page: Page, state: SpatialState): Promise<Locator> {
  const definition = state.catalog.find((item) => item.assembly === 'house')!;
  await page.getByRole('button', { name: content.edit, exact: true }).click();
  const inventory = page.getByRole('complementary', { name: content.inventory, exact: true });
  await inventory.getByRole('button', { name: content.select.replace('{name}', definition.name), exact: true }).click();
  return inventory.getByRole('region', { name: definition.name, exact: true });
}
