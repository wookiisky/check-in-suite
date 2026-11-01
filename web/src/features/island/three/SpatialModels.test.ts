import { describe, expect, it } from 'vitest';
import configuration from '../../../../../internal/island/spatial-scene.json';
import type { SpatialHouse } from './spatial-ui-types';
import { houseWallSide } from './SpatialModels';
import { hiddenWallSides } from './spatial-camera';

const house=configuration.scene.house as SpatialHouse;
describe('正式房屋共享墙体剖切',()=>{
  it('四向相机各自隐藏真实前墙，包含西/南卫生间隔墙',()=>{
    const sides=house.walls.map(wall=>houseWallSide(wall,house));
    expect(sides.slice(0,5)).toEqual(['west','east','north','south','south']);
    expect(sides.slice(5)).toEqual(['west','west','south']);
    expect([0,1,2,3].map(direction=>sides.filter(side=>hiddenWallSides(direction,true).includes(side)))).toEqual([
      ['east','south','south','south'],['east','north'],['west','north','west','west'],['west','south','south','west','west','south']
    ]);
  });
});
