import { describe, expect, it } from 'vitest';
import fixture from '../../../../internal/island/testdata/spatial-geometry-cases.json';
import houseConfiguration from '../../../../internal/island/spatial-houses.json';
import { spatialFootprintCovered, spatialRectCovered, spatialScene } from './spatial-geometry';

describe('厘米空间规则，与 Go 共用样例', () => {
  it('保留实际房屋派生通路的小数边界，越出地面仍拒绝',()=>{
    const rect=houseConfiguration.houses.find(item=>item.house_key==='tiny-treats-cottage-v1')!.door_clearance;
    expect(spatialRectCovered(rect,spatialScene.regions,['grass'])).toBe(true);
    expect(spatialRectCovered({...rect,min_x_cm:1499.5,max_x_cm:1500.5},spatialScene.regions,['grass'])).toBe(false);
    expect(spatialFootprintCovered({x_cm:0,z_cm:(rect.min_z_cm+rect.max_z_cm)/2,rotation:0},{width_cm:rect.max_x_cm-rect.min_x_cm,depth_cm:rect.max_z_cm-rect.min_z_cm},spatialScene.regions,['grass'])).toBe(false);
  });
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
