import { describe, expect, it } from 'vitest';
import { fitIslandView, fitHouseView } from './island-camera';
import { defaultScene } from './scene-definitions';
import { zoomAt, project } from './island-geometry';

describe('海边场景默认取景', () => {
  it.each([{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }])('在 $width × $height 视口保留天空，地面约六成在岸上', ({ width, height }) => {
    const insets = { top: 100, right: 0, bottom: 140, left: 0 };
    const camera = defaultScene.camera;
    const view = fitIslandView(width, height, insets);
    const groundTop = Math.max(insets.top, height * camera.skyRatio);
    const groundBottom = height - insets.bottom;
    const shoreY = view.y + camera.center.y * view.zoom;
    expect((groundBottom - shoreY) / (groundBottom - groundTop)).toBeCloseTo(camera.landRatio);
    expect(view.x + camera.center.x * view.zoom).toBe(width / 2);
  });

  it('抽屉展开后向上取景，桌面侧栏也会让出空间', () => {
    const open = fitIslandView(390, 844, { top: 100, right: 0, bottom: 380, left: 0 });
    const closed = fitIslandView(390, 844, { top: 100, right: 0, bottom: 100, left: 0 });
    expect(open.y).toBeLessThan(closed.y);
    const side = fitIslandView(1440, 900, { top: 100, right: 380, bottom: 100, left: 0 });
    expect(side.x + defaultScene.camera.center.x * side.zoom).toBe(530);
    expect(side.zoom).toBeGreaterThan(1);
    expect(side.zoom).toBeLessThanOrEqual(1.7);
  });

  it('窄屏的缩放按钮继续使用当前倍率，缩小后能返回默认视图', () => {
    const view = fitIslandView(390, 844, { top: 220, right: 12, bottom: 180, left: 12 });
    const pointer = { x: 195, y: 422 };
    const larger = zoomAt(view, pointer, 1.2);
    expect(larger.zoom).toBeCloseTo(view.zoom * 1.2);
    expect(zoomAt(larger, pointer, 1 / 1.2).zoom).toBeCloseTo(view.zoom);
    // 角色常用地面点在活动面板上方，而不是只保证岛屿中心可见。
    expect(view.y + 400 * view.zoom).toBeLessThan(844 - 180);
  });

  it('更换取景配置后采用新场景的基准和比例，极短窗口保持有限坐标', () => {
    const camera = { center: { x: 420, y: 250 }, editingCenter: { x: 420, y: 400 }, width: 700, height: 400, skyRatio: .1, landRatio: .7 };
    const view = fitIslandView(1000, 800, { top: 100, right: 0, bottom: 100, left: 0 }, camera);
    expect(view.x + camera.center.x * view.zoom).toBe(500);
    expect(view.y + camera.center.y * view.zoom).toBeCloseTo(280);
    const small = fitIslandView(100, 100, { top: 100, right: 200, bottom: 100, left: 0 }, camera);
    expect(Object.values(small).every(Number.isFinite)).toBe(true);
  });
});


describe('室内取景', () => {
  it.each([{ width: 1440, height: 900, right: 380, bottom: 140 }, { width: 390, height: 844, right: 12, bottom: 380 }, { width: 390, height: 664, right: 12, bottom: 440 }])('在 $width 宽视口完整显示地板与后墙并避开编辑面板', ({ width, height, right, bottom }) => {
    const insets = { top: 100, left: 12, right, bottom };
    const house = { x: -1.5, y: -2 };
    const view = fitHouseView(width, height, insets, house, { width: 13, depth: 9 });
    const origin = project(house);
    const bounds = { left: origin.x - 276, right: origin.x + 276, top: origin.y - 224, bottom: origin.y + 148 };
    expect(view.x + bounds.left * view.zoom).toBeGreaterThanOrEqual(insets.left - 1e-8);
    expect(view.x + bounds.right * view.zoom).toBeLessThanOrEqual(width - insets.right + 1e-8);
    expect(view.y + bounds.top * view.zoom).toBeGreaterThanOrEqual(insets.top - 1e-8);
    expect(view.y + bounds.bottom * view.zoom).toBeLessThanOrEqual(height - insets.bottom + 1e-8);
  });
});
