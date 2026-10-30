import layout from '../../../../internal/island/house-layout.json';

// 房屋和家具使用相同的地面投影，墙高只改变屏幕高度。
function point(x: number, y: number, height = 0): string {
  return `${(x - y) * 24},${(x + y) * 12 - height}`;
}

// 地面矩形的四个顶点共享坐标，避免墙脚和地板出现接缝。
function floor(x1: number, y1: number, x2: number, y2: number): string {
  return `${point(x1, y1)} ${point(x2, y1)} ${point(x2, y2)} ${point(x1, y2)}`;
}

// 墙面沿地面线段竖起，不用图片缩放模拟房间面积。
function wall(x1: number, y1: number, x2: number, y2: number, height: number): string {
  return `${point(x1, y1)} ${point(x2, y2)} ${point(x2, y2, height)} ${point(x1, y1, height)}`;
}

// 独立墙段让场景把隔墙与家具一起排序，门洞不绘制透明占位矩形。
export type BathroomPartition = `side-${number}` | 'front-left' | 'front-right';

interface PartitionDefinition {
  id: BathroomPartition; // 对应卫生间左墙和门洞两侧的墙段。
  depth: number; // 地面线段中点的投影深度，用于与室内家具排序。
  x1: number; // 墙段起点的室内横坐标。
  y1: number; // 墙段起点的室内纵坐标。
  x2: number; // 墙段终点的室内横坐标。
  y2: number; // 墙段终点的室内纵坐标。
}

const bath = layout.bathroom;
const door = layout.bathroomDoor;

export const bathroomPartitions: readonly PartitionDefinition[] = [
  ...Array.from({ length: 6 }, (_, index): PartitionDefinition => {
    const y1 = bath.minY + (bath.maxY - bath.minY) * index / 6;
    const y2 = bath.minY + (bath.maxY - bath.minY) * (index + 1) / 6;
    return { id: `side-${index}`, x1: bath.minX, y1, x2: bath.minX, y2, depth: (bath.minX + (y1 + y2) / 2) * 12 };
  }),
  { id: 'front-left', x1: bath.minX, y1: bath.maxY, x2: door.minX, y2: bath.maxY, depth: ((bath.minX + door.minX) / 2 + bath.maxY) * 12 },
  { id: 'front-right', x1: door.maxX, y1: bath.maxY, x2: bath.maxX, y2: bath.maxY, depth: ((door.maxX + bath.maxX) / 2 + bath.maxY) * 12 },
];

// 剖切隔墙保留墙厚和墙顶，室内较高的家具仍可从上方看见。
export function HousePartitionArtwork({ segment }: { segment: BathroomPartition }) {
  const part = bathroomPartitions.find((entry) => entry.id === segment)!;
  const height = layout.wallHeight * .6;
  const half = layout.wallThickness / 2;
  const side = segment.startsWith('side-');
  const dx = side ? half : 0;
  const dy = side ? 0 : half;
  const { x1, y1, x2, y2 } = part;
  return <g data-house-partition={segment} stroke="#8d927c" strokeWidth="1.2" strokeLinejoin="round" pointerEvents="none">
    <polygon points={wall(x1 + dx, y1 + dy, x2 + dx, y2 + dy, height)} fill={side ? '#e0e7d4' : '#d4dfcb'} stroke={side ? 'none' : undefined} />
    <polygon points={`${point(x1 - dx, y1 - dy, height)} ${point(x2 - dx, y2 - dy, height)} ${point(x2 + dx, y2 + dy, height)} ${point(x1 + dx, y1 + dy, height)}`} fill="#f4f2df" stroke={side ? 'none' : undefined} />
    {side && <polyline points={`${point(x1 - dx, y1, height)} ${point(x2 - dx, y2, height)}`} fill="none" />}
    {side && <polyline points={`${point(x1 + dx, y1, height)} ${point(x2 + dx, y2, height)}`} fill="none" />}
    {(!side || y2 === bath.maxY) && <polygon points={wall(x2 - dx, y2 - dy, x2 + dx, y2 + dy, height)} fill="#c4d0bc" />}
    <polyline points={`${point(x1 + dx, y1 + dy, 9)} ${point(x2 + dx, y2 + dy, 9)}`} fill="none" stroke="#b4c3ad" />
    {!side && <polyline points={`${point(segment === 'front-left' ? x2 : x1, y1 + dy, 2)} ${point(segment === 'front-left' ? x2 : x1, y1 + dy, height)}`} fill="none" stroke="#b59c75" strokeWidth="3" />}
  </g>;
}

// 凸窗三面共用窗台轮廓，外挑控制在建筑占地内，窗帘和花箱不形成新物件。
function HouseBayWindow({ x, start, end }: { x: number; start: number; end: number }) {
  const direction = Math.sign(x);
  const outer = x + direction * .35;
  const first = start + .35;
  const last = end - .35;
  const middle = (first + last) / 2;
  return <g data-house-bay="true" stroke="#a18a63" strokeWidth="1.5">
    <polygon points={`${point(x, start, 26)} ${point(outer, first, 26)} ${point(outer, last, 26)} ${point(x, end, 26)}`} fill="#d5b284" />
    <polygon points={`${point(x, start, 27)} ${point(outer, first, 27)} ${point(outer, first, 66)} ${point(x, start, 66)}`} fill="#b8d4c6" />
    <polygon points={`${point(outer, first, 27)} ${point(outer, last, 27)} ${point(outer, last, 66)} ${point(outer, first, 66)}`} fill="#c0d9c9" />
    <polygon points={`${point(outer, last, 27)} ${point(x, end, 27)} ${point(x, end, 66)} ${point(outer, last, 66)}`} fill="#a9c9be" />
    <polyline points={`${point(x, start, 66)} ${point(outer, first, 66)} ${point(outer, last, 66)} ${point(x, end, 66)}`} fill="none" stroke="#f5e7c9" strokeWidth="3" />
    <polyline points={`${point(outer, middle, 28)} ${point(outer, middle, 65)}`} fill="none" stroke="#f8ecd0" strokeWidth="2.5" />
    <polyline points={`${point(outer, first, 46)} ${point(outer, last, 46)}`} fill="none" stroke="#f8ecd0" strokeWidth="2.5" />
    <g data-house-curtains="true" fill="#ecdbba" stroke="#cbb997" strokeWidth=".8">
      <path d={`M${point(outer, first, 66)} L${point(outer, first + .56, 66)} Q${point(outer, first + .55, 52)} ${point(outer, first + .24, 42)} L${point(outer, first + .38, 28)} Q${point(outer, first + .15, 25)} ${point(outer, first, 29)}Z`} />
      <path d={`M${point(outer, last, 66)} L${point(outer, last - .56, 66)} Q${point(outer, last - .55, 52)} ${point(outer, last - .24, 42)} L${point(outer, last - .38, 28)} Q${point(outer, last - .15, 25)} ${point(outer, last, 29)}Z`} />
      <polyline points={`${point(outer, first + .04, 42)} ${point(outer, first + .26, 42)}`} fill="none" stroke="#b89567" strokeWidth="1.5" />
      <polyline points={`${point(outer, last - .04, 42)} ${point(outer, last - .26, 42)}`} fill="none" stroke="#b89567" strokeWidth="1.5" />
    </g>
    <polyline points={`${point(x, start - .12, 70)} ${point(x, end + .12, 70)}`} fill="none" stroke="#a88c61" strokeWidth="2.5" />
    <polygon points={`${point(outer, first + .15, 18)} ${point(outer, last - .15, 18)} ${point(outer, last - .15, 26)} ${point(outer, first + .15, 26)}`} fill="#bd9870" />
    <polyline points={`${point(outer, first + .12, 26)} ${point(outer, last - .12, 26)}`} fill="none" stroke="#e3c59a" strokeWidth="2" />
    {[first + .4, middle, last - .4].map((position, index) => <g key={position} transform={`translate(${point(outer, position, 28)})`} stroke="#70835b" strokeWidth="1">
      <path d="M0 3V-6M0-2Q-8-10-9-3Q-8 1 0 1M0-3Q7-13 9-6Q9-1 0 0" fill={index % 2 ? '#a5b784' : '#8da373'} />
      {index === 1 && <circle cy="-7" r="2.5" fill="#e8c28c" stroke="none" />}
    </g>)}
  </g>;
}

// 壁灯的局部暖色不使用全场发光，也不占据地面布置空间。
function HouseWallLight({ x, y, height = 55 }: { x: number; y: number; height?: number }) {
  return <g data-house-wall-light="true" transform={`translate(${point(x, y, height)})`} pointerEvents="none">
    <ellipse cy="1" rx="13" ry="19" fill="#f4d28c" opacity=".18" stroke="none" />
    <ellipse cy="1" rx="8" ry="12" fill="#ffdfa0" opacity=".2" stroke="none" />
    <path d="M-2 8V-2H2V8M-5 8H5" fill="none" stroke="#a38b5e" strokeWidth="2" />
    <path d="M-6 0-4-9H4L6 0Z" fill="#f7dfaa" stroke="#b79b6c" strokeWidth="1" />
    <path d="M-5 0H5" fill="none" stroke="#fff0ca" strokeWidth="1.5" />
  </g>;
}

// 房屋展开后保留后墙与开放生活区，独立隔墙由场景按深度另行绘制。
export function HouseArtwork({ indoor, cottage }: { indoor: boolean; cottage: boolean }) {
  const x = layout.width / 2;
  const y = layout.depth / 2;
  const h = layout.wallHeight;
  const roofDark = cottage ? '#b96858' : '#bb8061';
  const roofLight = cottage ? '#d78e73' : '#dba17b';
  return <g className="island-house-art" stroke="#827154" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
    <polygon points={floor(-x - .12, -y + .05, x + .12, y + .25)} transform="translate(0 7)" fill="#526b4c" opacity=".15" stroke="none" />
    <polygon points={`${point(-x, y)} ${point(x, y)} ${point(x, y, -8)} ${point(-x, y, -8)}`} fill="#c0a57d" />
    <polygon points={`${point(x, -y)} ${point(x, y)} ${point(x, y, -8)} ${point(x, -y, -8)}`} fill="#cfb48b" />
    <g data-house-floor="true">
      <polygon points={floor(-x, -y, x, y)} fill="#e5c49a" />
      <g stroke="#c3a47a" strokeWidth=".8" opacity=".65">
        {Array.from({ length: 15 }, (_, index) => -y + (index + 1) * .5).map((row) => <polyline key={row} points={`${point(-x, row)} ${point(x, row)}`} fill="none" />)}
        {Array.from({ length: 16 }, (_, index) => -y + index * .5).map((row, index) => <g key={row}>
          {[-5, -2.5, 0, 2.5, 5].map((column) => <polyline key={column} points={`${point(column + (index % 2 ? .65 : 0), row)} ${point(column + (index % 2 ? .65 : 0), row + .5)}`} fill="none" />)}
        </g>)}
      </g>
      {/* 地毯只表示开放区域的用途，不形成角色或家具不能通过的隔断。 */}
      <polygon points={floor(-x + .4, -3.6, -1.7, -.4)} fill="#d9d1b0" stroke="#c3bb95" strokeWidth="1" />
      <polygon points={floor(-x + .56, -3.44, -1.86, -.56)} fill="none" stroke="#f0e6c4" strokeWidth="1.5" />
      <polygon points={floor(-x + .4, .1, -1.7, 3.4)} fill="#b4c2a4" stroke="#93a88a" strokeWidth="1" />
      <polygon points={floor(-x + .58, .28, -1.88, 3.22)} fill="none" stroke="#d8dfbb" strokeWidth="1.8" />
      <polygon points={floor(-1.4, -y, bath.minX, -2.15)} fill="#dddcc0" stroke="#c7c7a9" strokeWidth=".8" />
      <g stroke="#eef0d9" strokeWidth="1">
        {[-.7, 0, .7, 1.4, 2.1].map((column) => <polyline key={column} points={`${point(column, -y)} ${point(column, -2.15)}`} fill="none" />)}
        {[-3.4, -2.8, -2.2].map((row) => <polyline key={row} points={`${point(-1.4, row)} ${point(bath.minX, row)}`} fill="none" />)}
      </g>
      <g data-bathroom-floor="true">
        <polygon points={floor(bath.minX, bath.minY, bath.maxX, bath.maxY)} fill="#c8d7c6" stroke="#97ae9e" strokeWidth="1" />
        <g stroke="#ebefdd" strokeWidth="1">
          {Array.from({ length: Math.ceil((bath.maxX - bath.minX) / .55) - 1 }, (_, index) => bath.minX + (index + 1) * .55).map((column) => <polyline key={column} points={`${point(column, bath.minY)} ${point(column, bath.maxY)}`} fill="none" />)}
          {[-3.4, -2.8, -2.2, -1.6].map((row) => <polyline key={row} points={`${point(bath.minX, row)} ${point(bath.maxX, row)}`} fill="none" />)}
        </g>
        <polyline points={`${point(door.minX, door.y)} ${point(door.maxX, door.y)}`} fill="none" stroke="#e6e9d5" strokeWidth="3" />
      </g>
    </g>
    <g data-house-back="true">
      <polygon points={wall(-x, -y, -x, y, h)} fill="#e8dbc0" />
      <polygon points={wall(-x, -y, x, -y, h)} fill="#f5e9ce" />
      <polyline points={`${point(-x, y, 7)} ${point(-x, -y, 7)} ${point(x, -y, 7)}`} fill="none" stroke="#bda583" strokeWidth="3" />
      <polyline points={`${point(-x, y, h)} ${point(-x, -y, h)} ${point(x, -y, h)}`} fill="none" stroke="#f8efd9" strokeWidth="4" />
      <HouseBayWindow x={-x} start={-2.9} end={.2} />
      <HouseWallLight x={-x + .01} y={1.15} />
      <g data-house-picture="true">
        <polygon points={`${point(-x + .015, 2, 30)} ${point(-x + .015, 3.1, 30)} ${point(-x + .015, 3.1, 55)} ${point(-x + .015, 2, 55)}`} fill="#d7b282" stroke="#aa8c63" strokeWidth="2" />
        <polygon points={`${point(-x + .02, 2.12, 33)} ${point(-x + .02, 2.98, 33)} ${point(-x + .02, 2.98, 52)} ${point(-x + .02, 2.12, 52)}`} fill="#eddfba" stroke="none" />
        <path d={`M${point(-x + .025, 2.18, 34)} L${point(-x + .025, 2.42, 44)} L${point(-x + .025, 2.6, 38)} L${point(-x + .025, 2.82, 47)} L${point(-x + .025, 2.95, 34)}Z`} fill="#96ad85" stroke="none" />
      </g>
      <polygon points={`${point(-1.2, -y, 35)} ${point(1.5, -y, 35)} ${point(1.5, -y, 67)} ${point(-1.2, -y, 67)}`} fill="#b0d0c4" stroke="#aa9470" strokeWidth="3" />
      <polyline points={`${point(.15, -y, 35)} ${point(.15, -y, 67)}`} fill="none" stroke="#fff1d7" strokeWidth="3" />
      <polyline points={`${point(-1.2, -y, 51)} ${point(1.5, -y, 51)}`} fill="none" stroke="#fff1d7" strokeWidth="3" />
      <HouseWallLight x={2} y={-y + .01} height={57} />
      <polygon points={`${point(3.1, -y, 49)} ${point(4.35, -y, 49)} ${point(4.35, -y, 70)} ${point(3.1, -y, 70)}`} fill="#c6ded1" stroke="#a7ae95" strokeWidth="2.5" />
    </g>
    {!indoor && <>
      <g data-house-front="true">
        <polygon points={wall(-x, y, x, y, h)} fill="#efe0bd" />
        <polygon points={wall(x, -y, x, y, h)} fill="#dccaab" />
        <polygon points={`${point(-x, y, h)} ${point(x, y, h)} ${point(0, y, h + 57)}`} fill="#e9d7af" />
        <polygon points={`${point(-.7, y, 0)} ${point(.7, y, 0)} ${point(.7, y, 57)} ${point(-.7, y, 57)}`} fill="#819f8b" stroke="#8d7856" strokeWidth="3" />
        <polygon points={`${point(-.51, y + .01, 7)} ${point(.51, y + .01, 7)} ${point(.51, y + .01, 48)} ${point(-.51, y + .01, 48)}`} fill="none" stroke="#b7cbb0" strokeWidth="2" />
        <circle cx={(.43 - y) * 24} cy={(.43 + y) * 12 - 26} r="2.2" fill="#ebcb7b" stroke="none" />
        {[-3.8, 2.2].map((column) => <g key={column}>
          <polygon points={`${point(column, y, 28)} ${point(column + 1.6, y, 28)} ${point(column + 1.6, y, 62)} ${point(column, y, 62)}`} fill="#a8cbc1" stroke="#a08c65" strokeWidth="3" />
          <polyline points={`${point(column + .8, y, 28)} ${point(column + .8, y, 62)}`} fill="none" stroke="#f9eed2" strokeWidth="3" />
          <polyline points={`${point(column, y, 45)} ${point(column + 1.6, y, 45)}`} fill="none" stroke="#f9eed2" strokeWidth="3" />
          <polyline points={`${point(column - .12, y + .05, 27)} ${point(column + 1.72, y + .05, 27)}`} fill="none" stroke="#a88f69" strokeWidth="4" />
        </g>)}
        <HouseBayWindow x={x} start={-1.9} end={1.3} />
        <HouseWallLight x={1.05} y={y + .015} height={48} />
        <polyline points={`${point(-x, y, 8)} ${point(x, y, 8)} ${point(x, -y, 8)}`} fill="none" stroke="#bfa47c" strokeWidth="3" />
      </g>
      <g data-house-roof="true">
        <polygon points={`${point(-x - .25, -y - .25, h + 3)} ${point(-x - .25, y + .25, h + 3)} ${point(0, y + .25, h + 60)} ${point(0, -y - .25, h + 60)}`} fill={roofDark} />
        <polygon points={`${point(0, -y - .25, h + 60)} ${point(0, y + .25, h + 60)} ${point(x + .25, y + .25, h + 3)} ${point(x + .25, -y - .25, h + 3)}`} fill={roofLight} />
        <g fill="none" stroke={cottage ? '#ae6754' : '#b3815e'} strokeWidth="1.2" opacity=".65">
          {[.2, .4, .6, .8].map((fraction) => (x + .25) * fraction).map((column) => <polyline key={column} points={`${point(column, -y - .25, h + 60 - column * 57 / (x + .25))} ${point(column, y + .25, h + 60 - column * 57 / (x + .25))}`} />)}
          {[-3.2, -1.6, 0, 1.6, 3.2].map((row) => <polyline key={row} points={`${point(0, row, h + 60)} ${point(x + .25, row, h + 3)}`} />)}
        </g>
        <polyline points={`${point(-x - .25, y + .25, h + 3)} ${point(0, y + .25, h + 60)} ${point(x + .25, y + .25, h + 3)} ${point(x + .25, -y - .25, h + 3)}`} fill="none" stroke="#806a4e" strokeWidth="4" />
        <polyline points={`${point(0, -y - .25, h + 60)} ${point(0, y + .25, h + 60)}`} fill="none" stroke={cottage ? '#efb399' : '#f1c79b'} strokeWidth="4" />
      </g>
    </>}
    <g data-house-porch-floor="true">
      <polygon points={`${point(-1.4, y)} ${point(1.4, y)} ${point(1.4, y + .43)} ${point(-1.4, y + .43)}`} fill="#d3ad7b" />
      <polygon points={`${point(-1.4, y + .43)} ${point(1.4, y + .43)} ${point(1.4, y + .43, -5)} ${point(-1.4, y + .43, -5)}`} fill="#b68e61" />
      <polyline points={`${point(-1.4, y + .22)} ${point(1.4, y + .22)}`} fill="none" stroke="#bd9567" strokeWidth="1" />
      <polygon points={floor(-.65, y + .04, .65, y + .35)} fill="#a6b28c" stroke="#889a75" strokeWidth=".8" />
      <polyline points={`${point(-.52, y + .12)} ${point(.52, y + .12)}`} fill="none" stroke="#d5d8ae" strokeWidth="1" />
    </g>
    {!indoor && <g data-house-porch-roof="true">
      {[-1.2, 1.2].map((column) => <g key={column}>
        <polyline points={`${point(column, y + .3, 1)} ${point(column, y + .3, 64)}`} fill="none" stroke="#b38e62" strokeWidth="4" />
        <polyline points={`${point(column, y + .3, 50)} ${point(column + (column < 0 ? .35 : -.35), y + .3, 64)}`} fill="none" stroke="#c49c6b" strokeWidth="2.5" />
      </g>)}
      <polygon points={`${point(-1.5, y - .02, 70)} ${point(1.5, y - .02, 70)} ${point(1.5, y + .43, 63)} ${point(-1.5, y + .43, 63)}`} fill={roofDark} stroke="#957351" strokeWidth="1.5" />
      <polyline points={`${point(-1.5, y + .43, 62)} ${point(1.5, y + .43, 62)}`} fill="none" stroke="#795f43" strokeWidth="3" />
      <polyline points={`${point(-1.5, y - .02, 70)} ${point(1.5, y - .02, 70)}`} fill="none" stroke="#e2b78a" strokeWidth="2" />
    </g>}
  </g>;
}
