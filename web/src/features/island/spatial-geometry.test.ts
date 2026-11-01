import { describe, expect, it } from 'vitest';
import fixture from '../../../../internal/island/testdata/spatial-geometry-cases.json';
import { spatialFootprintCovered, spatialScene } from './spatial-geometry';

describe('厘米空间规则，与 Go 共用样例', () => {
  for (const sample of fixture.cases) {
    it(sample.name, () => {
      const regions = fixture.regions[sample.regions as keyof typeof fixture.regions];
      expect(spatialFootprintCovered(sample, sample, regions, sample.allowed)).toBe(sample.valid);
    });
  }
  it('拒绝小数坐标、非有限值和无效旋转', () => {
    const footprint = { width_cm: 100, depth_cm: 100 };
    for (const placement of [{x_cm: 0.1,z_cm:0,rotation:0},{x_cm:NaN,z_cm:0,rotation:0},{x_cm:0,z_cm:0,rotation:4}]) {
      expect(spatialFootprintCovered(placement, footprint, spatialScene.regions, ['grass'])).toBe(false);
    }
  });
});
