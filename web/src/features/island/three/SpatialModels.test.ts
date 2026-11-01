import { describe, expect, it } from 'vitest';
import configuration from '../../../../../internal/island/spatial-scene.json';
import type { SpatialHouse } from './spatial-ui-types';
import { houseWallSide } from './SpatialModels';
import { hiddenWallSides } from './spatial-camera';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { cloneStaticModel, houseHiddenNodes } from './SpatialModels';

const house=configuration.scene.house as SpatialHouse;
describe('正式房屋共享墙体剖切',()=>{
  it('完整房型按节点剖切屋顶和四向墙，保留原始模型缓存',()=>{
    const source=new Group();
    for(const name of ['roof','floor','wall_north','wall_south','wall_east','wall_west']) {
      const node=new Mesh(new BoxGeometry(),new MeshBasicMaterial());node.name=name;source.add(node);
    }
    const configured={...house,model_url:'/house.glb',roof_nodes:['roof'],wall_nodes:{north:['wall_north'],south:['wall_south'],east:['wall_east'],west:['wall_west']}};
    expect(houseHiddenNodes(configured,0,false)).toEqual([]);
    for(let direction=0;direction<4;direction++) {
      const hidden=houseHiddenNodes(configured,direction,true);
      expect(hidden).toEqual(['roof',...hiddenWallSides(direction,true).map(side=>`wall_${side}`)]);
      const instance=cloneStaticModel(source,undefined,hidden);
      expect(instance.getObjectByName('floor')?.visible).toBe(true);
      for(const name of hidden)expect(instance.getObjectByName(name)?.visible).toBe(false);
      for(const node of source.children)expect(node.visible).toBe(true);
    }
  });
  it('四向相机各自隐藏真实前墙，包含西/南卫生间隔墙',()=>{
    const sides=house.walls.map(wall=>houseWallSide(wall,house));
    expect(sides.slice(0,5)).toEqual(['west','east','north','south','south']);
    expect(sides.slice(5)).toEqual(['west','west','south']);
    expect([0,1,2,3].map(direction=>sides.filter(side=>hiddenWallSides(direction,true).includes(side)))).toEqual([
      ['east','south','south','south'],['east','north'],['west','north','west','west'],['west','south','south','west','west','south']
    ]);
  });
});
