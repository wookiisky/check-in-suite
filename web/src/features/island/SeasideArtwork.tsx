import { memo, useId } from 'react';
import { project } from './island-geometry';
import type { IslandPoint } from './island-types';
import type { SceneArtworkProps, SceneSkyProps } from './scene-presentation';
import { terrainAt } from './scene-terrain';
import './seaside-art.css';

// 绘制与地形查询读取同一世界坐标；海浪只改变外观，不移动岸线规则。
function projectedPath(points: readonly IslandPoint[], close = false): string {
  return points.map((point, index) => {
    const position = project(point);
    return `${index === 0 ? 'M' : 'L'}${position.x} ${position.y}`;
  }).join(' ') + (close ? 'Z' : '');
}

// 天空保持在屏幕背景中，地面的平移缩放不会把云带进沙滩。
export const SceneSky = memo(function SceneSky({ width, height, scene, staticMotion, motionPaused }: SceneSkyProps) {
  const id = useId();
  const skyHeight = height * scene.camera.skyRatio;
  return <g className="scene-sky scene-ambient" data-static={staticMotion} data-paused={motionPaused} aria-hidden="true" pointerEvents="none">
    <defs><linearGradient id={`${id}-sky`} x2="0" y2="1"><stop stopColor="#bde4ec"/><stop offset="1" stopColor="#e6f2e8"/></linearGradient></defs>
    <rect width={width} height={skyHeight} fill={`url(#${id}-sky)`}/>
    <path d={`M0 ${skyHeight - 2} Q${width * .3} ${skyHeight - 7} ${width * .6} ${skyHeight - 2} T${width} ${skyHeight - 3}`} fill="none" stroke="#e7f5e9" strokeWidth="5"/>
    {[{ x: .12, y: .38, scale: .8 }, { x: .5, y: .24, scale: 1.05 }, { x: .84, y: .57, scale: .64 }].map((cloud, index) =>
      <g key={index} transform={`translate(${cloud.x * width} ${cloud.y * skyHeight}) scale(${cloud.scale})`}>
        <g className={`scene-cloud-drift scene-cloud-${index}`}>
          <ellipse cy="16" rx="66" ry="10" fill="#aed1d1" opacity=".18"/>
          <path d="M-59 10Q-70-6-47-12Q-43-35-21-32Q-2-55 20-29Q45-33 48-11Q73-9 65 8Q45 20-59 10Z" fill="#fffdf1"/>
          <path d="M-49 9Q-21 17 9 10Q31 17 54 8" fill="none" stroke="#dfecdf" strokeWidth="3" strokeLinecap="round"/>
        </g>
      </g>)}
  </g>;
});

// 完整海边从有限地形绘出，远处海色只延伸视觉背景，不作为可布置水域。
export const SeasideArtwork = memo(function SeasideArtwork({ scene, staticMotion, motionPaused }: SceneArtworkProps) {
  const id = useId();
  const water = scene.terrain.filter((region) => region.kind === 'water');
  const shore = projectedPath(scene.shoreline);
  const grass = projectedPath(scene.grassline);
  return <g className="seaside-art scene-ambient" data-scene-key={scene.key} data-static={staticMotion} data-paused={motionPaused} pointerEvents="none" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-water`} x1="0" y1="-400" x2="0" y2="160" gradientUnits="userSpaceOnUse"><stop stopColor="#74bfc9"/><stop offset=".65" stopColor="#92d3d1"/><stop offset="1" stopColor="#b7e3d3"/></linearGradient>
      <linearGradient id={`${id}-grass`} x1="0" y1="180" x2="0" y2="850" gradientUnits="userSpaceOnUse"><stop stopColor="#bdd18d"/><stop offset="1" stopColor="#9dbc78"/></linearGradient>
      <linearGradient id={`${id}-sand`} x1="0" y1="120" x2="0" y2="220" gradientUnits="userSpaceOnUse"><stop stopColor="#f3e6bd"/><stop offset="1" stopColor="#e5d4a6"/></linearGradient>
      <clipPath id={`${id}-water-clip`}>{water.map((region, index) => <path key={index} d={projectedPath(region.polygon, true)}/>)}</clipPath>
    </defs>
    <rect x="-6500" y="-6500" width="14000" height="14000" fill={`url(#${id}-water)`}/>
    {scene.terrain.map((region, index) => <path key={index} data-terrain={region.kind} d={projectedPath(region.polygon, true)} fill={`url(#${id}-${region.kind})`}/>)}
    <g clipPath={`url(#${id}-water-clip)`}>
      <g className="seaside-water-ripples" fill="none" stroke="#edf8e9" strokeWidth="2.5" strokeLinecap="round" opacity=".48">
        {Array.from({ length: 60 }, (_, index) => {
          const x = -500 + index % 10 * 210 + Math.sin(index * 4) * 50;
          const y = -480 + Math.floor(index / 10) * 110 + Math.cos(index * 3) * 20;
          return <path key={index} d={`M${x} ${y}q24 5 48 0m14 0h16`}/>;
        })}
      </g>
      <path d={shore} fill="none" stroke="#c6eadb" strokeWidth="38" opacity=".55"/>
      <g className="seaside-shore-wave"><path d={shore} fill="none" stroke="#fff9e5" strokeWidth="14" opacity=".7"/></g>
      <g className="seaside-shore-wave seaside-shore-wave-follow"><path d={shore} fill="none" stroke="#f4fbe9" strokeWidth="4" opacity=".8"/></g>
    </g>
    <path d={shore} fill="none" stroke="#fcf1cf" strokeWidth="3"/>
    <path d={grass} fill="none" stroke="#859f62" strokeWidth="2"/>
    <path d={grass} transform="translate(0 4)" fill="none" stroke="#d6dda1" strokeWidth="5" opacity=".75"/>
    {/* 小径和草叶只是地面纹理，保留既有物品与角色的地面位置。 */}
    <path d="M476 300Q440 332 467 350Q494 370 523 407Q547 434 588 445" stroke="#90ae6c" strokeWidth="27" strokeLinecap="round" fill="none" opacity=".4"/>
    <path d="M476 300Q440 332 467 350Q494 370 523 407Q547 434 588 445" stroke="#dfcea5" strokeWidth="20" strokeLinecap="round" fill="none"/>
    <g stroke="#bcae81" strokeWidth="1.4" fill="#ebdfb9"><path d="m463 321 10-4 9 4-10 5Z"/><path d="m457 343 11-3 9 5-11 5Z"/><path d="m486 366 11-4 10 5-11 4Z"/><path d="m514 397 12-5 11 5-12 6Z"/><path d="m550 433 12-4 12 4-11 6Z"/></g>
    {Array.from({ length: 95 }, (_, index) => {
      const point = { x: -24 + index % 13 * 4.5 + Math.sin(index * 2), y: -22 + Math.floor(index / 13) * 5 + Math.cos(index) };
      if (terrainAt(scene.terrain, point) !== 'grass') return null;
      const position = project(point);
      return <g key={index} transform={`translate(${position.x} ${position.y})`} opacity=".55">
        <path d="m-5 0-3-4m8 4 1-7m2 7 4-4" stroke="#779b5d" strokeWidth="1.6" strokeLinecap="round"/>
        {index % 4 === 0 && <g fill={index % 8 === 0 ? '#fbf0c3' : '#f1d8b4'}><circle cx="1" cy="-9" r="3"/><circle cx="-2" cy="-6" r="3"/><circle cx="4" cy="-6" r="3"/><circle cx="1" cy="-5" r="2" fill="#dcba6e"/></g>}
      </g>;
    })}
    {scene.shoreline.filter((_, index) => index % 8 === 0).map((point, index) => {
      const position = project(point);
      return <g key={index} transform={`translate(${position.x + 10} ${position.y + 24})`} fill="#fcf1d2" stroke="#c9b990" strokeWidth="1">
        <path d="M-5 0Q-7-7 0-7Q7-6 5 0Z"/><path d="M0-6V0m-3-5 1 5m5-5-1 5" fill="none"/>
        <ellipse cx="23" cy="6" rx="3" ry="1.5" fill="#bda985" stroke="none"/>
      </g>;
    })}
  </g>;
});
