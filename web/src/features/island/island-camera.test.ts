import { describe, expect, it } from 'vitest';
import { fitIslandView } from './island-camera';
import { defaultScene } from './scene-definitions';
import { zoomAt } from './island-geometry';

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
