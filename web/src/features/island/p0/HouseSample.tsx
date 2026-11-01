import { useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Mesh } from 'three';
import { hiddenWalls, previewHouse } from './preview-space';
import type { PreviewPoint, PreviewWall } from './preview-space';

export const houseSampleURLs = ['wall', 'wall-doorway-square', 'floor', 'roof-flat-center'].map((name) => `/models/p0/kenney/${name}.glb`);

/** 构件实例复用不可变网格和材质，不由单个实例释放缓存资源。 */
interface BuildingPartProps {
  url: string; // 已审查的 Kenney GLB。
  position: PreviewPoint; // 米制世界位置。
  rotation?: number; // 地面朝向。
  scale?: PreviewPoint; // 合并构件时的尺寸倍率。
}

// 每处构件独立变换，共享加载缓存而不复用同一个场景节点。
function BuildingPart({ url, position, rotation = 0, scale = [1, 1, 1] }: BuildingPartProps) {
  const model = useLoader(GLTFLoader, url);
  const instance = useMemo(() => {
    const result = model.scene.clone(true);
    result.traverse((child) => {
      if (child instanceof Mesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    return result;
  }, [model]);
  return <primitive object={instance} position={position} rotation={[0, rotation, 0]} scale={scale} dispose={null} />;
}

/** 房屋剖切只影响渲染，人物仍从固定门洞进出。 */
interface HouseSampleProps {
  direction: number; // 四向相机索引。
  open: boolean; // 屋顶和遮挡墙体是否打开。
}

// 实际 Kenney 墙长 2 米、墙高 2.4 米；九块地板组成 6 米方形房间。
export function HouseSample({ direction, open }: HouseSampleProps) {
  const hidden = hiddenWalls(direction, open);
  const walls: { side: PreviewWall; position: PreviewPoint; rotation: number; doorway: boolean }[] = [];
  for (const offset of [-2, 0, 2]) {
    walls.push(
      { side: 'north', position: [offset, previewHouse.floorHeight, -3], rotation: Math.PI / 2, doorway: false },
      { side: 'south', position: [offset, previewHouse.floorHeight, 3], rotation: Math.PI / 2, doorway: offset === 0 },
      { side: 'east', position: [3, previewHouse.floorHeight, offset], rotation: 0, doorway: false },
      { side: 'west', position: [-3, previewHouse.floorHeight, offset], rotation: 0, doorway: false },
    );
  }
  return <group name="p0-house">
    {[-2, 0, 2].flatMap((x) => [-2, 0, 2].map((z) => <BuildingPart key={`floor-${x}-${z}`} url={houseSampleURLs[2]!} position={[x, 0, z]} />))}
    <BuildingPart url={houseSampleURLs[2]!} position={[0, 0, 4]} />
    {walls.filter((wall) => !hidden.includes(wall.side)).map((wall, index) => <BuildingPart key={`${wall.side}-${index}`} url={houseSampleURLs[wall.doorway ? 1 : 0]!} position={wall.position} rotation={wall.rotation} />)}
    {!open && <BuildingPart url={houseSampleURLs[3]!} position={[0, previewHouse.floorHeight + previewHouse.wallHeight, 0]} scale={[3.04, 1, 3.04]} />}
  </group>;
}
