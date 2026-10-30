import { memo, useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import { project } from './island-geometry';
import type { IslandPoint } from './island-types';
import type { SceneDefinition } from './scene-definitions';
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

// 沿投影横向、纵深换算世界坐标，装饰与地形使用同一套坐标。
function groundPoint(horizontal: number, depth: number): IslandPoint {
  return { x: (horizontal + depth) / 2, y: (depth - horizontal) / 2 };
}

// 固定种子的伪随机数，让纹理每次渲染都落在同一位置。
function noise(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

// 沿岸线按屏幕方向插值，配套装饰跟随场景定义而不是写死屏幕像素。
function coastPoint(line: readonly IslandPoint[], horizontal: number): IslandPoint {
  for (let index = 1; index < line.length; index += 1) {
    const start = line[index - 1]!, end = line[index]!;
    const from = start.x - start.y, to = end.x - end.y;
    if (horizontal <= to || index === line.length - 1) {
      const ratio = Math.min(1, Math.max(0, (horizontal - from) / (to - from || 1)));
      return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
    }
  }
  return line[0] ?? { x: 0, y: 0 };
}

// across 为 0 时在水线，为 1 时在草坪边缘。
function beachSpot(scene: SceneDefinition, horizontal: number, across: number): IslandPoint {
  const shore = coastPoint(scene.shoreline, horizontal), grass = coastPoint(scene.grassline, horizontal);
  return project({ x: shore.x + (grass.x - shore.x) * across, y: shore.y + (grass.y - shore.y) * across });
}

// 从草坪边缘再向内陆推进若干纵深单位。
function inlandSpot(scene: SceneDefinition, horizontal: number, depth: number): IslandPoint {
  const grass = coastPoint(scene.grassline, horizontal);
  return project({ x: grass.x + depth / 2, y: grass.y + depth / 2 });
}

// 沿折线生成连续小弧，用于浪花花边和草坪垂边。
function scallopPath(points: readonly IslandPoint[], offset: number, bulge: number, divisions: number): string {
  const projected = points.map(project);
  const segments: string[] = [];
  projected.forEach((point, index) => {
    if (index === 0) { segments.push(`M${point.x} ${point.y + offset}`); return; }
    const previous = projected[index - 1]!;
    for (let step = 1; step <= divisions; step += 1) {
      const from = (step - 1) / divisions, to = step / divisions, middle = (from + to) / 2;
      const control = { x: previous.x + (point.x - previous.x) * middle, y: previous.y + (point.y - previous.y) * middle + offset + bulge };
      const end = { x: previous.x + (point.x - previous.x) * to, y: previous.y + (point.y - previous.y) * to + offset };
      segments.push(`Q${control.x.toFixed(1)} ${control.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`);
    }
  });
  return segments.join(' ');
}

// 天空保持在屏幕背景中，地面的平移缩放不会把云带进沙滩。
export const SceneSky = memo(function SceneSky({ width, height, scene, staticMotion, motionPaused }: SceneSkyProps) {
  const id = useId();
  const skyHeight = height * scene.camera.skyRatio;
  // 装饰随天空高度缩放，手机窄天空中不显得拥挤。
  const unit = Math.min(1, Math.max(.55, skyHeight / 140));
  const sun = { x: width * .42, y: skyHeight * .46 };
  const clouds = [{ x: .08, y: .34, scale: .72 }, { x: .27, y: .66, scale: .46 }, { x: .6, y: .28, scale: .95 }, { x: .9, y: .56, scale: .62 }];
  return <g className="scene-sky scene-ambient" data-static={staticMotion} data-paused={motionPaused} aria-hidden="true" pointerEvents="none">
    <defs>
      <linearGradient id={`${id}-sky`} x2="0" y2="1"><stop stopColor="#8dcfe7"/><stop offset=".6" stopColor="#c8eaf1"/><stop offset="1" stopColor="#f7f1da"/></linearGradient>
      <radialGradient id={`${id}-sun`}><stop stopColor="#fffbe3" stopOpacity=".95"/><stop offset=".3" stopColor="#fff2c2" stopOpacity=".6"/><stop offset="1" stopColor="#fff2c2" stopOpacity="0"/></radialGradient>
      <clipPath id={`${id}-clip`}><rect width={width} height={skyHeight}/></clipPath>
    </defs>
    <rect width={width} height={skyHeight} fill={`url(#${id}-sky)`}/>
    {/* 天空装饰裁在天空内，不能盖住下方的海面与物件。 */}
    <g clipPath={`url(#${id}-clip)`}>
      <circle className="scene-sun-glow" cx={sun.x} cy={sun.y} r={78 * unit} fill={`url(#${id}-sun)`}/>
      <circle cx={sun.x} cy={sun.y} r={17 * unit} fill="#fff7d4" stroke="#ffe39b" strokeWidth={4 * unit}/>
      {clouds.map((cloud, index) =>
        <g key={index} transform={`translate(${cloud.x * width} ${cloud.y * skyHeight}) scale(${cloud.scale * unit})`}>
          <g className={`scene-cloud-drift scene-cloud-${index}`}>
            <ellipse cy="15" rx="64" ry="8" fill="#9ccbd8" opacity=".22"/>
            <path d="M-60 12Q-74-4-50-10Q-46-34-22-30Q-4-54 20-30Q44-36 48-12Q74-10 66 8Q58 14-60 12Z" fill="#fffdf4"/>
            <path d="M-62 11Q-30 4 0 9Q32 2 66 7Q58 14-60 12Z" fill="#e4eff1"/>
            <path d="M-40-12Q-33-24-20-24M2-36Q15-40 23-29" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round"/>
          </g>
        </g>)}
      <g transform={`translate(${width * .28} ${skyHeight * .3}) scale(${unit})`}>
        <g className="scene-birds" fill="none" stroke="#5c7d87" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M-9 0q4.5-5 9 0q4.5-5 9 0"/><path d="M15-10q3.5-4 7 0q3.5-4 7 0"/><path d="M9 10q3-3.5 6 0q3-3.5 6 0"/>
        </g>
      </g>
      {/* 远方地平线：一道雾光、两座远岛和一艘小帆船。 */}
      <rect y={skyHeight - 3} width={width} height="3" fill="#eef8f1" opacity=".85"/>
      <g transform={`translate(${width * .12} ${skyHeight + 1}) scale(${unit})`}>
        <path d="M-82 0Q-62-10-42-12Q-26-26-4-24Q14-31 31-18Q54-14 82 0Z" fill="#86b9b2"/>
        <path d="M-42-12Q-26-26-4-24Q14-31 31-18Q12-21-4-17Q-22-19-42-12Z" fill="#a3cec3"/>
        <path d="M8-27v-10m0 0q-6-2-9 2m9-2q6-3 9 1m-9-1q-2-5-6-6m6 6q3-5 7-5" stroke="#6c9c93" strokeWidth="1.6" fill="none" strokeLinecap="round"/>
      </g>
      <g transform={`translate(${width * .76} ${skyHeight + 1}) scale(${unit})`}>
        <path d="M-48 0Q-32-12-10-13Q12-16 27-8Q39-5 48 0Z" fill="#91c1b8"/>
        <path d="M2-13 3.6-33h4.8L10-13Z" fill="#fffaf0" stroke="#79a49b" strokeWidth="1"/>
        <path d="M2.5-19.5h7M3.1-26.5h5.8" stroke="#ec806b" strokeWidth="2.6"/>
        <path d="M3-33h6l-3-5Z" fill="#ec806b"/><circle cx="6" cy="-35" r="1.4" fill="#ffe08a"/>
      </g>
      <g transform={`translate(${width * .6} ${skyHeight - 1}) scale(${unit * .9})`}>
        <g className="scene-boat"><g className="scene-boat-hull">
          <path d="M-14-4h28l-5 6h-18Z" fill="#c97a5e" stroke="#9c5a44" strokeWidth="1"/>
          <path d="M0-4V-30" stroke="#7a5a44" strokeWidth="1.4"/>
          <path d="M1.5-29 14-6H1.5Z" fill="#fffaf0" stroke="#d8cdb7" strokeWidth=".8"/>
          <path d="M-1.5-25-11-6h9.5Z" fill="#f5e6c8" stroke="#d8cdb7" strokeWidth=".8"/>
        </g></g>
      </g>
    </g>
  </g>;
});

// 椰子树只放在旧活动范围之外，避免高大树冠被角色或物件错误遮挡。
function Palm({ at, scale, flip = false }: { at: IslandPoint; scale: number; flip?: boolean }) {
  return <g transform={`translate(${at.x} ${at.y}) scale(${flip ? -scale : scale} ${scale})`}>
    <ellipse cx="16" cy="2" rx="32" ry="7" fill="#5c874a" opacity=".26"/>
    <path d="M-7 0Q-3-62 5-117L14-115Q7-60 7 0Z" fill="#c39461" stroke="#8a6440" strokeWidth="1.6" strokeLinejoin="round"/>
    <path d="M-5-20q6 3 12 0M-3-44q6 3 12 0M0-68q6 3 11 0M3-92q5 3 10 0" stroke="#9c7349" strokeWidth="1.6" fill="none" strokeLinecap="round"/>
    <g className="seaside-palm-crown" style={{ transformOrigin: '10px -116px' }} strokeWidth="1.5" strokeLinejoin="round">
      <path d="M10-116Q-14-142-40-140Q-14-132 10-112Z" fill="#5f9150" stroke="#46733f"/>
      <path d="M10-116Q36-146 60-138Q34-130 10-112Z" fill="#5f9150" stroke="#46733f"/>
      <path d="M10-116Q-8-106-20-74Q-2-100 10-110Z" fill="#6a9d57" stroke="#46733f"/>
      <path d="M10-116Q28-106 36-76Q22-100 10-110Z" fill="#6a9d57" stroke="#46733f"/>
      <path d="M10-116Q-22-128-50-100Q-20-112 10-110Z" fill="#79ad61" stroke="#46733f"/>
      <path d="M10-116Q44-128 70-98Q40-112 10-110Z" fill="#79ad61" stroke="#46733f"/>
      <path d="M8-115Q-16-123-42-104M12-115Q38-123 62-104" fill="none" stroke="#a5cf80" strokeWidth="1.6" strokeLinecap="round"/>
      <g fill="#8a6440" stroke="none"><circle cx="6" cy="-111" r="4"/><circle cx="14" cy="-110" r="4"/><circle cx="10" cy="-106" r="4"/></g>
    </g>
  </g>;
}

// 圆润灌木点缀草坪边缘和两侧，不进入中心活动范围。
function Bush({ at, scale }: { at: IslandPoint; scale: number }) {
  return <g transform={`translate(${at.x} ${at.y}) scale(${scale})`} stroke="#557f45" strokeWidth="1.5">
    <ellipse cy="2" rx="29" ry="7" fill="#5c874a" opacity=".26" stroke="none"/>
    <circle cx="-13" cy="-9" r="12" fill="#6c9d53"/><circle cx="13" cy="-8" r="12" fill="#6c9d53"/>
    <circle cy="-16" r="15" fill="#7dad5e"/>
    <path d="M-8-24q5-5 11-3M-21-13q2-4 6-5" stroke="#a6cf80" strokeWidth="2.4" fill="none" strokeLinecap="round"/>
    <g fill="#f19a84" stroke="none"><circle cx="-6" cy="-12" r="2.2"/><circle cx="7" cy="-20" r="2.2"/><circle cx="15" cy="-7" r="2.2"/></g>
  </g>;
}

// 小花丛只是平铺的地面装饰。
function FlowerPatch({ at, palette }: { at: IslandPoint; palette: readonly string[] }) {
  const flowers = [[-14, -2], [-5, -7], [5, -1], [14, -6], [-9, 5], [9, 6], [0, 2]] as const;
  return <g transform={`translate(${at.x} ${at.y})`}>
    <ellipse cy="2" rx="24" ry="8" fill="#86ab62" opacity=".45"/>
    {flowers.map(([x, y], index) => <g key={index} transform={`translate(${x} ${y})`}>
      <path d="M0 0v-6m0 3-4-2m4 2 3-3" stroke="#6f9957" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
      <g fill={palette[index % palette.length]}><circle cy="-10" r="2.6"/><circle cx="-2.6" cy="-7.4" r="2.6"/><circle cx="2.6" cy="-7.4" r="2.6"/><circle cy="-5" r="2.4"/></g>
      <circle cy="-7.5" r="1.6" fill="#e3b54f"/>
    </g>)}
  </g>;
}

// 沙滩遮阳伞与浴巾，放在沙带后侧不遮挡旧活动范围。
function Umbrella({ at }: { at: IslandPoint }) {
  return <g transform={`translate(${at.x} ${at.y})`}>
    <ellipse cx="8" cy="4" rx="36" ry="9" fill="#c8ad78" opacity=".35"/>
    <path d="M-18 8 8-4 38 8 12 20Z" fill="#f5b1a5" stroke="#d98579" strokeWidth="1.2"/>
    <path d="M-9 12 17 0M1 16l26-12" stroke="#fff4e6" strokeWidth="3"/>
    <path d="M0 2V-58" stroke="#8a6440" strokeWidth="2.5" strokeLinecap="round"/>
    <path d="M-38-48Q-34-74 0-76Q34-74 38-48Q29-54 19-48Q10-54 0-48Q-10-54-19-48Q-29-54-38-48Z" fill="#ee7e68" stroke="#c75f4e" strokeWidth="1.5" strokeLinejoin="round"/>
    <path d="M0-76Q-6-60-10-51Q-5-53 0-48Q5-53 10-51Q6-60 0-76ZM-38-48Q-34-68-22-73Q-26-60-28-51Q-33-53-38-48ZM38-48Q34-68 22-73Q26-60 28-51Q33-53 38-48Z" fill="#fff6e8"/>
    <circle cy="-77" r="2.6" fill="#c75f4e"/>
  </g>;
}

// 小沙堡与水桶，同样只是地面装饰。
function Sandcastle({ at }: { at: IslandPoint }) {
  return <g transform={`translate(${at.x} ${at.y})`} stroke="#b99a62" strokeWidth="1.4" strokeLinejoin="round">
    <ellipse cy="2" rx="26" ry="6" fill="#cdb682" opacity=".45" stroke="none"/>
    <path d="M-20 0V-14H20V0Z" fill="#ead198"/>
    <path d="M-18-14V-28h10v14M8-14V-28h10v14" fill="#efd8a2"/>
    <path d="M-18-28v-3h3v2h4v-2h3v3M8-28v-3h3v2h4v-2h3v3" fill="#efd8a2"/>
    <path d="M-5-14V-36H5v22Z" fill="#f2dda8"/>
    <path d="M-5-36v-3h3v2h4v-2h3v3" fill="#f2dda8"/>
    <path d="M0-39v-10" stroke="#8a6440"/><path d="M0-49l8 3-8 3Z" fill="#ee7e68" stroke="#c75f4e" strokeWidth="1"/>
    <path d="M-3 0v-6a3 3 0 0 1 6 0v6Z" fill="#c8a76c" stroke="none"/>
    <g transform="translate(32 4)" stroke="#4b8fae">
      <path d="M-7-13h14l-2 13h-10Z" fill="#6db6d8"/><path d="M-6-13q6-9 12 0" fill="none"/>
      <path d="M12-2 24-14" stroke="#d98a3c" strokeWidth="2" strokeLinecap="round"/>
    </g>
  </g>;
}

// 海星和贝壳压扁后贴在斜俯视的沙面上。
function Starfish({ at, rotate }: { at: IslandPoint; rotate: number }) {
  return <g transform={`translate(${at.x} ${at.y}) scale(1 .62) rotate(${rotate})`}>
    <path d="M0-9 2.7-2.9 9.3-2.8 4.1 1.3 5.9 7.9 0 4.1-5.9 7.9-4.1 1.3-9.3-2.8-2.7-2.9Z" fill="#f3a273" stroke="#d27c52" strokeWidth="1.2" strokeLinejoin="round"/>
    <g fill="#ffd2b0"><circle cy="-4" r=".9"/><circle cx="3" cy="0" r=".9"/><circle cx="-3" cy="0" r=".9"/><circle cy="2" r=".9"/></g>
  </g>;
}

function Shell({ at, tint }: { at: IslandPoint; tint: string }) {
  return <g transform={`translate(${at.x} ${at.y})`} fill={tint} stroke="#cdb08a" strokeWidth="1">
    <path d="M-6 0Q-7-8 0-8Q7-8 6 0Q0 2-6 0Z"/><path d="M0-7V0m-3-6 1 6m5-6-1 6" fill="none"/>
  </g>;
}

// 浅水礁石的浪圈随岸浪呼吸，礁石本身不是可布置水域物件。
function Rocks({ at, scale }: { at: IslandPoint; scale: number }) {
  return <g transform={`translate(${at.x} ${at.y}) scale(${scale})`} strokeLinejoin="round">
    <ellipse className="seaside-rock-foam" cy="4" rx="42" ry="11" fill="none" stroke="#f4fcf6" strokeWidth="3" opacity=".75"/>
    <path d="M-30 4Q-31-14-14-19Q-2-25 6-14Q10-6 7 4Z" fill="#8e9e98" stroke="#6c7c77" strokeWidth="1.5"/>
    <path d="M-24-6Q-20-14-12-15" stroke="#b8c6bf" strokeWidth="3" fill="none" strokeLinecap="round"/>
    <path d="M3 4Q4-8 16-10Q28-10 29 4Z" fill="#a0afa8" stroke="#6c7c77" strokeWidth="1.5"/>
    <path d="M-34 4Q0 10 33 4" stroke="#d3f3e8" strokeWidth="3" fill="none" strokeLinecap="round"/>
  </g>;
}

function Buoy({ at }: { at: IslandPoint }) {
  return <g transform={`translate(${at.x} ${at.y})`}>
    <g className="seaside-buoy">
      <ellipse cy="2" rx="14" ry="4" fill="none" stroke="#eaf9f2" strokeWidth="2" opacity=".85"/>
      <path d="M-9 0Q-9-14 0-16Q9-14 9 0Q0 4-9 0Z" fill="#ee7e68" stroke="#b9584a" strokeWidth="1.4"/>
      <path d="M-8.6-5Q0-2 8.6-5V-9.5Q0-6.5-8.6-9.5Z" fill="#fff6e8"/>
      <path d="M0-16V-24" stroke="#6b5a4a" strokeWidth="1.6"/><circle cy="-25" r="2.4" fill="#ffd76a"/>
    </g>
  </g>;
}

const flowerColors = ['#fff8e3', '#ffd96e', '#f7b8c2', '#d8c8f2'] as const;

// 完整海边从有限地形绘出，远处海色只延伸视觉背景，不作为可布置水域。
export const SeasideArtwork = memo(function SeasideArtwork({ scene, staticMotion, motionPaused }: SceneArtworkProps) {
  const id = useId();
  const clip = (kind: string) => scene.terrain.filter((region) => region.kind === kind).map((region, index) => <path key={index} d={projectedPath(region.polygon, true)}/>);
  const shore = projectedPath(scene.shoreline);
  const decor = useMemo(() => {
    // 纹理按世界网格抖动取样，再用地形查询筛到对应地面。
    const ripples = Array.from({ length: 77 }, (_, index) => {
      const x = -620 + index % 11 * 210 + (noise(index) - .5) * 120;
      const y = -500 + Math.floor(index / 11) * 100 + (noise(index + 50) - .5) * 40;
      const length = 28 + noise(index + 99) * 36;
      return `M${x.toFixed(1)} ${y.toFixed(1)}q${length / 2} 5 ${length} 0${noise(index + 7) > .5 ? `m12 0h${(10 + noise(index + 3) * 10).toFixed(1)}` : ''}`;
    });
    const sparkles = Array.from({ length: 24 }, (_, index) => ({ x: -600 + noise(index * 3 + 1) * 2200, y: -470 + noise(index * 3 + 2) * 540, scale: .6 + noise(index * 3 + 3) * .7, delay: noise(index + 400) * 4.2 }));
    const speckles: { x: number; y: number; r: number; light: boolean }[] = [];
    for (let column = 0; column < 60; column += 1) for (let row = 0; row < 6; row += 1) {
      const seed = column * 7 + row * 131;
      if (noise(seed) < .45) continue;
      const point = groundPoint(-72 + column * 2.4 + noise(seed + 1) * 2, -20 + row * 1.7 + noise(seed + 2) * 1.4);
      if (terrainAt(scene.terrain, point) !== 'sand') continue;
      const position = project(point);
      speckles.push({ x: position.x, y: position.y, r: 1 + noise(seed + 3) * .9, light: noise(seed + 4) > .6 });
    }
    const tufts: { x: number; y: number; flower: string | null; scale: number }[] = [];
    for (let column = 0; column < 24; column += 1) for (let row = 0; row < 20; row += 1) {
      const seed = column * 13 + row * 977 + 5;
      if (noise(seed) < .48) continue;
      const point = groundPoint(-46 + column * 4 + noise(seed + 1) * 3.4, -14 + row * 2.6 + noise(seed + 2) * 2.2);
      if (terrainAt(scene.terrain, point) !== 'grass') continue;
      const position = project(point);
      tufts.push({ x: position.x, y: position.y, flower: noise(seed + 3) > .78 ? flowerColors[Math.floor(noise(seed + 4) * flowerColors.length)]! : null, scale: .8 + noise(seed + 5) * .5 });
    }
    const patches = Array.from({ length: 28 }, (_, index) => {
      const position = project(groundPoint(-48 + noise(index * 5 + 900) * 96, -12 + noise(index * 5 + 901) * 52));
      const rx = 60 + noise(index * 5 + 902) * 90;
      return { x: position.x, y: position.y, rx, ry: rx * .34, light: index % 2 === 0 };
    });
    return { ripples, sparkles, speckles, tufts, patches };
  }, [scene]);
  // 高大装饰按纵深排序，近处的树冠压在远处物件之上。
  const tall: { y: number; node: ReactNode }[] = [
    { at: beachSpot(scene, -11, .58), make: (at: IslandPoint) => <Umbrella at={at}/> },
    { at: beachSpot(scene, 9, .42), make: (at: IslandPoint) => <Sandcastle at={at}/> },
    { at: inlandSpot(scene, -21, 1.2), make: (at: IslandPoint) => <Palm at={at} scale={1}/> },
    { at: inlandSpot(scene, 23, .8), make: (at: IslandPoint) => <Palm at={at} scale={1.06} flip/> },
    { at: inlandSpot(scene, -28, 4), make: (at: IslandPoint) => <Palm at={at} scale={.9} flip/> },
    { at: inlandSpot(scene, 31, 5), make: (at: IslandPoint) => <Palm at={at} scale={.92}/> },
    { at: inlandSpot(scene, -17, 2.2), make: (at: IslandPoint) => <Bush at={at} scale={.95}/> },
    { at: inlandSpot(scene, 17.5, 1.8), make: (at: IslandPoint) => <Bush at={at} scale={.85}/> },
    { at: project(groundPoint(-24, 5)), make: (at: IslandPoint) => <Bush at={at} scale={1.05}/> },
    { at: project(groundPoint(25, 7)), make: (at: IslandPoint) => <Bush at={at} scale={1}/> },
  ].map(({ at, make }) => ({ y: at.y, node: make(at) })).sort((a, b) => a.y - b.y);
  return <g className="seaside-art scene-ambient" data-scene-key={scene.key} data-static={staticMotion} data-paused={motionPaused} pointerEvents="none" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-water`} x1="0" y1="-460" x2="0" y2="150" gradientUnits="userSpaceOnUse"><stop stopColor="#4aa5c3"/><stop offset=".45" stopColor="#68bdcd"/><stop offset=".85" stopColor="#8fd5d2"/><stop offset="1" stopColor="#b2e5d7"/></linearGradient>
      <linearGradient id={`${id}-grass`} x1="0" y1="150" x2="0" y2="900" gradientUnits="userSpaceOnUse"><stop stopColor="#c9dc95"/><stop offset=".45" stopColor="#afca82"/><stop offset="1" stopColor="#92b46c"/></linearGradient>
      <linearGradient id={`${id}-sand`} x1="0" y1="110" x2="0" y2="230" gradientUnits="userSpaceOnUse"><stop stopColor="#f7eac3"/><stop offset="1" stopColor="#ecd9a7"/></linearGradient>
      <clipPath id={`${id}-water-clip`}>{clip('water')}</clipPath>
      <clipPath id={`${id}-sand-clip`}>{clip('sand')}</clipPath>
      <clipPath id={`${id}-grass-clip`}>{clip('grass')}</clipPath>
    </defs>
    <rect x="-6500" y="-6500" width="14000" height="14000" fill={`url(#${id}-water)`}/>
    {scene.terrain.map((region, index) => <path key={index} data-terrain={region.kind} d={projectedPath(region.polygon, true)} fill={`url(#${id}-${region.kind})`}/>)}
    {/* 海面：波纹、闪光、浅水带和往复的岸浪，全部裁在水域内。 */}
    <g clipPath={`url(#${id}-water-clip)`}>
      <g className="seaside-water-ripples" fill="none" stroke="#eaf8f2" strokeWidth="2.5" strokeLinecap="round" opacity=".5">
        {decor.ripples.map((d, index) => <path key={index} d={d}/>)}
      </g>
      <g fill="#ffffff">
        {decor.sparkles.map((sparkle, index) => <g key={index} transform={`translate(${sparkle.x.toFixed(1)} ${sparkle.y.toFixed(1)}) scale(${sparkle.scale.toFixed(2)})`}>
          <path className="seaside-sparkle" style={{ animationDelay: `-${sparkle.delay.toFixed(2)}s` }} opacity=".7" d="M0-7 1.6-1.6 7 0 1.6 1.6 0 7-1.6 1.6-7 0-1.6-1.6Z"/>
        </g>)}
      </g>
      <path d={shore} fill="none" stroke="#a4e1d5" strokeWidth="84" opacity=".45"/>
      <path d={shore} fill="none" stroke="#c7efe1" strokeWidth="36" opacity=".6"/>
      <g className="seaside-foam-lace"><path d={scallopPath(scene.shoreline, -16, -4, 2)} fill="none" stroke="#f6fdf7" strokeWidth="2.4" strokeLinecap="round" opacity=".75"/></g>
      <g className="seaside-shore-wave"><path d={shore} fill="none" stroke="#fffaf0" strokeWidth="13" opacity=".75"/></g>
      <g className="seaside-shore-wave seaside-shore-wave-follow"><path d={shore} fill="none" stroke="#f4fbe9" strokeWidth="4" opacity=".85"/></g>
    </g>
    <Rocks at={project(groundPoint(-19, -26))} scale={1}/>
    <Rocks at={project(groundPoint(18, -28.5))} scale={.75}/>
    <Rocks at={project(groundPoint(-31, -23.5))} scale={.6}/>
    <Buoy at={project(groundPoint(10, -32))}/>
    {/* 沙滩：近水处的湿沙带和细小沙粒。 */}
    <g clipPath={`url(#${id}-sand-clip)`}>
      <path d={shore} fill="none" stroke="#dcc690" strokeWidth="24" opacity=".5"/>
      <path d={scallopPath(scene.shoreline, 13, 3, 3)} fill="none" stroke="#e6d4a1" strokeWidth="1.6" opacity=".8"/>
      {decor.speckles.map((speck, index) => <circle key={index} cx={speck.x.toFixed(1)} cy={speck.y.toFixed(1)} r={speck.r.toFixed(2)} fill={speck.light ? '#fff7dd' : '#d6bf8a'} opacity=".7"/>)}
    </g>
    <path d={shore} fill="none" stroke="#fcf3d6" strokeWidth="3"/>
    {/* 草坪略高于沙滩：沙上的投影、圆润垂边和描边。 */}
    <path d={scallopPath(scene.grassline, 6, 4, 3)} fill="none" stroke="#cdb47c" strokeWidth="4" opacity=".55"/>
    <path d={`${scallopPath(scene.grassline, 2, 4.5, 3)} ${[...scene.grassline].reverse().map((point) => { const position = project(point); return `L${position.x} ${position.y - 8}`; }).join(' ')}Z`} fill={`url(#${id}-grass)`}/>
    <path d={scallopPath(scene.grassline, 2, 4.5, 3)} fill="none" stroke="#8aab64" strokeWidth="1.8"/>
    <g clipPath={`url(#${id}-grass-clip)`}>
      {decor.patches.map((patch, index) => <ellipse key={index} cx={patch.x.toFixed(1)} cy={patch.y.toFixed(1)} rx={patch.rx.toFixed(1)} ry={patch.ry.toFixed(1)} fill={patch.light ? '#d5e5a3' : '#90b26a'} opacity={patch.light ? .36 : .14}/>)}
      {decor.tufts.map((tuft, index) => <g key={index} transform={`translate(${tuft.x.toFixed(1)} ${tuft.y.toFixed(1)}) scale(${tuft.scale.toFixed(2)})`}>
        <path d="m-5 0-3-4m8 4 1-7m2 7 4-4" stroke="#76995b" strokeWidth="1.6" strokeLinecap="round" opacity=".6"/>
        {tuft.flower && <g fill={tuft.flower}><circle cx="1" cy="-9" r="2.8"/><circle cx="-1.8" cy="-6.4" r="2.8"/><circle cx="3.8" cy="-6.4" r="2.8"/><circle cx="1" cy="-6.8" r="1.7" fill="#dcae4f"/></g>}
      </g>)}
    </g>
    {/* 小径和草叶只是地面纹理，保留既有物品与角色的地面位置。 */}
    <path d="M476 300Q440 332 467 350Q494 370 523 407Q547 434 588 445" stroke="#90ae6c" strokeWidth="27" strokeLinecap="round" fill="none" opacity=".4"/>
    <path d="M476 300Q440 332 467 350Q494 370 523 407Q547 434 588 445" stroke="#dfcea5" strokeWidth="20" strokeLinecap="round" fill="none"/>
    <g stroke="#bcae81" strokeWidth="1.4" fill="#ebdfb9"><path d="m463 321 10-4 9 4-10 5Z"/><path d="m457 343 11-3 9 5-11 5Z"/><path d="m486 366 11-4 10 5-11 4Z"/><path d="m514 397 12-5 11 5-12 6Z"/><path d="m550 433 12-4 12 4-11 6Z"/></g>
    <FlowerPatch at={project(groundPoint(-20, 10))} palette={flowerColors}/>
    <FlowerPatch at={project(groundPoint(19.5, 11))} palette={['#f7b8c2', '#fff8e3', '#ffd96e']}/>
    <FlowerPatch at={inlandSpot(scene, -13, 1.6)} palette={['#ffd96e', '#fff8e3']}/>
    {/* 沙滩小物件平贴地面，放在旧活动范围之外。 */}
    <Starfish at={beachSpot(scene, -5, .45)} rotate={18}/>
    <Starfish at={beachSpot(scene, 15, .62)} rotate={-24}/>
    <Starfish at={beachSpot(scene, -25, .4)} rotate={40}/>
    <Shell at={beachSpot(scene, -15, .35)} tint="#fcefd8"/>
    <Shell at={beachSpot(scene, 4, .3)} tint="#f9dcd2"/>
    <Shell at={beachSpot(scene, 20, .4)} tint="#fcefd8"/>
    <Shell at={beachSpot(scene, -31, .5)} tint="#f9dcd2"/>
    <Shell at={beachSpot(scene, 27, .3)} tint="#fcefd8"/>
    <g fill="#b9b4a2" stroke="#99937f" strokeWidth=".8">
      {[[-18, .75], [-17.4, .82], [26, .7], [26.6, .78], [-2, .8]].map(([horizontal, across], index) => {
        const at = beachSpot(scene, horizontal!, across!);
        return <ellipse key={index} cx={at.x} cy={at.y} rx={3 + index % 2} ry={2 + index % 2 * .6}/>;
      })}
    </g>
    {tall.map((entry, index) => <g key={index}>{entry.node}</g>)}
  </g>;
});
