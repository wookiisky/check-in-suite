import { describe, expect, it } from 'vitest';
import { cameraPosition, doorRoute, hiddenWalls, moveAlongRoute, rotateCamera } from './preview-space';

describe('P0 房屋与相机空间', () => {
  it('只在四个方向间旋转并保持固定俯角', () => {
    expect(rotateCamera(0, -1)).toBe(3);
    expect(rotateCamera(3, 1)).toBe(0);
    const positions = [0, 1, 2, 3].map((direction) => cameraPosition(direction));
    expect(new Set(positions.map((point) => point.join(','))).size).toBe(4);
    expect(new Set(positions.map((point) => point[1])).size).toBe(1);
  });

  it('打开室内后仅切除当前相机前方的两面墙', () => {
    expect(hiddenWalls(0, false)).toEqual([]);
    expect(hiddenWalls(0, true)).toEqual(['south', 'east']);
    expect(hiddenWalls(1, true)).toEqual(['north', 'east']);
    expect(hiddenWalls(2, true)).toEqual(['north', 'west']);
    expect(hiddenWalls(3, true)).toEqual(['south', 'west']);
  });

  it('切除的墙面与相机实际所在象限一致', () => {
    for (const direction of [0, 1, 2, 3]) {
      const [x, , z] = cameraPosition(direction);
      const frontWalls = [z > 0 ? 'south' : 'north', x > 0 ? 'east' : 'west'];
      expect(hiddenWalls(direction, true)).toEqual(frontWalls);
    }
  });

  it('人物进出都经过正 z 墙中央的同一门洞', () => {
    expect(doorRoute(true).map((point) => point[0])).toEqual([0, 0, 0]);
    expect(doorRoute(true).map((point) => point[2])).toEqual([5, 3, 0]);
    expect(doorRoute(false)).toEqual([...doorRoute(true)].reverse());
  });

  it('按速度沿路线推进，到达端点后不越界', () => {
    const route = doorRoute(true);
    expect(moveAlongRoute(route, 0)).toEqual({ position: route[0], arrived: false, facing: Math.PI });
    expect(moveAlongRoute(route, 1)).toEqual({ position: [0, 0.1, 4], arrived: false, facing: Math.PI });
    expect(moveAlongRoute(route, 100)).toEqual({ position: route[2], arrived: true, facing: Math.PI });
  });
});
