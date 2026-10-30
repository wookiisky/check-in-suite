import { describe, expect, it } from 'vitest';
import { clampLayout } from './accessory-layout';

describe('旋转饰品的画布边界', () => {
  it('旋转后按完整包围盒限制尺寸和中心', () => {
    const result = clampLayout({ x: 0.1, y: 0.9, size: 1, rotation: 45, layer: 1 });
    expect(result.size).toBeCloseTo(1 / Math.sqrt(2));
    expect(result.x).toBeCloseTo(0.5);
    expect(result.y).toBeCloseTo(0.5);
  });

  it('归一化角度，整直角不额外缩小，最小尺寸仍生效', () => {
    const full = clampLayout({ x: 0.5, y: 0.5, size: 1, rotation: -90, layer: -1 });
    expect(full.rotation).toBe(270);
    expect(full.size).toBeCloseTo(1);
    const small = clampLayout({ x: -1, y: 2, size: 0, rotation: 405, layer: 1 });
    expect(small.rotation).toBe(45);
    expect(small.size).toBe(0.05);
    expect(small.x).toBeCloseTo(0.05 / Math.sqrt(2));
    expect(small.y).toBeCloseTo(1 - 0.05 / Math.sqrt(2));
  });
});
