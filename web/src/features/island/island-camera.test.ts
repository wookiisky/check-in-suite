import { describe, expect, it } from 'vitest';
import { fitIslandView } from './island-camera';

describe('全屏小岛视口', () => {
  it('场景中心落在浮层以外的可用区域，抽屉展开后向上移动', () => {
    const open = fitIslandView(390, 844, { top: 100, right: 0, bottom: 380, left: 0 });
    const closed = fitIslandView(390, 844, { top: 100, right: 0, bottom: 100, left: 0 });
    expect(open.y + 335 * open.zoom).toBe(282);
    expect(closed.y + 335 * closed.zoom).toBe(422);
  });
  it('桌面侧栏占用右侧空间，缩放仍有界', () => {
    const view = fitIslandView(1440, 900, { top: 100, right: 380, bottom: 100, left: 0 });
    expect(view.x + 500 * view.zoom).toBe(530);
    expect(view.zoom).toBeGreaterThan(1);
    expect(view.zoom).toBeLessThanOrEqual(1.7);
  });
});
