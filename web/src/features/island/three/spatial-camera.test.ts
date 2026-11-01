import { describe, expect, it } from 'vitest';
import { cameraBasis, cameraTarget, dragCamera, groundFromWorld, hiddenWallSides, snappedPlacement, zoomCamera } from './spatial-camera';

describe('3D四向相机与厘米变换', () => {
  it('相机方位和剖墙使用一致的世界坐标符号', () => {
    expect([0,1,2,3].map((direction) => hiddenWallSides(direction, true))).toEqual([['south','east'],['north','east'],['north','west'],['south','west']]);
    expect(hiddenWallSides(0, false)).toEqual([]);
    expect(cameraBasis(0).forward[0]).toBeGreaterThan(0);
    expect(cameraBasis(1).forward[1]).toBeLessThan(0);
  });
  it('屏幕横向拖动沿相机右轴反向平移，缩放及平移有界', () => {
    const moved = dragCamera({x:0,z:0,zoom:1,direction:0}, 100,0,0.02);
    expect(moved.x).toBeCloseTo(-Math.SQRT2); expect(moved.z).toBeCloseTo(Math.SQRT2);
    expect(zoomCamera({...moved,zoom:99}, 2).zoom).toBe(6);
    expect(zoomCamera({...moved,zoom:0.01},0.1).zoom).toBe(0.65);
    expect(Math.abs(dragCamera({...moved,x:1000,z:1000},0,0,1).x)).toBeLessThanOrEqual(15);
  });
  it('面板占用改变相机目标，地面焦点进入剩余区域中心', () => {
    const base={x:0,z:0,zoom:1,direction:0};
    const a=cameraTarget(base, {top:0,right:0,bottom:0,left:0},0.02);
    const b=cameraTarget(base, {top:100,right:300,bottom:0,left:0},0.02);
    expect(a).toEqual([0,0,0]); expect(b[0]).not.toBe(a[0]);
  });
  it('室内局部坐标来自房屋逆变换，网格吸附仍保存整数厘米', () => {
    const house={x_cm:500,z_cm:-200,rotation:1};
    expect(groundFromWorld({x:6,z:-2},'indoor',house)).toEqual({x_cm:0,z_cm:-100});
    expect(snappedPlacement({x_cm:32.6,z_cm:-47.2})).toEqual({x_cm:30,z_cm:-50});
    expect(groundFromWorld({x:6,z:-2},'outdoor',house)).toEqual({x_cm:600,z_cm:-200});
  });
});
