import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { CharacterArtwork, GroundArtwork, ItemArtwork } from './IslandArtwork';
import type { IslandActor } from './island-activity';
import { canPlace, clampPlacement, project, zoomAt, houseArtworkScale, projectInterior, unprojectInterior } from './island-geometry';
import type { IslandDefinition, IslandPlacement, IslandPoint, IslandView } from './island-types';
import { fitIslandView } from './island-camera';
import type { IslandInsets } from './island-camera';
import content from './content.json';

// 场景只接收当前草稿，所有保存和所有权判断由页面及服务端完成。
interface SceneProps {
  insets: IslandInsets; // 浮层占用之外的可见区域。
  placements: IslandPlacement[]; // 当前显示布局。
  catalog: IslandDefinition[]; // 物品展示和互动能力。
  actor: IslandActor; // 单一角色活动状态。
  avatar: string; // 当前画像对应的受控角色素材。
  editing: boolean; // 区分拖动画布和摆放。
  indoor: boolean; // 布置时主动展开室内。
  selected: string | null; // 当前调整的实例。
  staticMotion: boolean; // 账户偏好或暂停状态。
  onSelect: (id: string) => void; // 选择物品。
  onMove: (placement: IslandPlacement) => void; // 更新本地草稿。
  onActivity: (id: string) => void; // 开始已有互动。
  onBlocked: () => void; // 无法摆放的可见反馈。
}

// 一次拖动保留原始位置，缩放不会累计坐标误差。
interface SceneDrag {
  pointer: IslandPoint; // 按下时SVG坐标。
  view: IslandView; // 按下时视图。
  placement: IslandPlacement | null; // 空值表示平移场景。
  targetID: string | null; // 捕获指针前按下的物品，不能依赖捕获后的click目标。
  moved: boolean; // 拖动后不触发点击互动。
}

const initialView: IslandView = { x: 0, y: 0, zoom: 1 };

// 室内局部坐标投影到房屋地板，仍使用相同的固定斜俯视角。
function scenePoint(point: IslandPoint, indoor: boolean, house: IslandPlacement | undefined, definition: IslandDefinition | undefined): IslandPoint {
  const result = project(point);
  if (!indoor || !house || !definition) return result;
  return projectInterior(point, house, definition);
}

// SVG整体变换仅影响显示，物件保存地面坐标。
export function IslandScene({ insets, placements, catalog, actor, avatar, editing, indoor, selected, staticMotion, onSelect, onMove, onActivity, onBlocked }: SceneProps) {
  const [view, setView] = useState<IslandView>(initialView);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 760 });
  const pointers = useRef(new Map<number, IslandPoint>());
  const drag = useRef<SceneDrag | null>(null);
  const suppressedClick = useRef(false);
  const house = placements.find((item) => catalog.find((entry) => entry.key === item.item_key)?.category === 'house');
  const houseDefinition = catalog.find((item) => item.key === house?.item_key);
  const resetView = () => setView(fitIslandView(size.width, size.height, insets));
  const houseOpen = editing ? indoor : actor.zone === 'indoor';
  const dusk = placements.some((item) => catalog.find((entry) => entry.key === item.item_key)?.model === 'dusk');
  // 视口使用实际像素，避免竖屏出现固定viewBox的上下留白。
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      setSize({ width: bounds.width || 1000, height: bounds.height || 760 });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element); window.addEventListener('resize', measure); measure();
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => { setView(fitIslandView(size.width, size.height, insets)); }, [size, insets]);

  // DOM矩阵包括响应式缩放与留白，避免手机长宽比改变拖放比例。
  function svgPoint(clientX: number, clientY: number): IslandPoint {
    const element = svg.current;
    const matrix = element?.getScreenCTM?.();
    if (element && matrix) {
      const point = element.createSVGPoint(); point.x = clientX; point.y = clientY;
      return point.matrixTransform(matrix.inverse());
    }
    const rect = element?.getBoundingClientRect();
    return { x: (clientX - (rect?.left ?? 0)) * size.width / (rect?.width || size.width), y: (clientY - (rect?.top ?? 0)) * size.height / (rect?.height || size.height) };
  }
  // 原生非被动监听阻止缩放时页面同时滚动，卸载后释放监听。
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = svgPoint(event.clientX, event.clientY);
      setView((current) => zoomAt(current, point, Math.exp(-event.deltaY * 0.0015)));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  // 场景捕获指针，让拖动离开物件之后仍能结束。
  function start(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    const point = svgPoint(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (pointers.current.size > 1) { drag.current = null; suppressedClick.current = true; return; }
    const id = (event.target as Element).closest('[data-placement-id]')?.getAttribute('data-placement-id');
    const placement = editing ? placements.find((item) => item.id === id) : undefined;
    if (placement) onSelect(placement.id);
    drag.current = { pointer: point, view, targetID: id ?? null, placement: placement && catalog.find((item) => item.key === placement.item_key)?.movable ? placement : null, moved: false };
    suppressedClick.current = false;
  }
  // 双指同时平移缩放；单指按当前模式平移场景或调整物件。
  function move(event: PointerEvent<SVGSVGElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    const oldPoints = [...pointers.current.values()];
    const point = svgPoint(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, point);
    const nextPoints = [...pointers.current.values()];
    if (oldPoints.length >= 2) {
      const oldA = oldPoints[0]!, oldB = oldPoints[1]!, nextA = nextPoints[0]!, nextB = nextPoints[1]!;
      const oldCenter = { x: (oldA.x + oldB.x) / 2, y: (oldA.y + oldB.y) / 2 };
      const nextCenter = { x: (nextA.x + nextB.x) / 2, y: (nextA.y + nextB.y) / 2 };
      const distance = Math.hypot(oldB.x - oldA.x, oldB.y - oldA.y);
      setView((current) => { const next = zoomAt(current, oldCenter, distance ? Math.hypot(nextB.x - nextA.x, nextB.y - nextA.y) / distance : 1); return { ...next, x: next.x + nextCenter.x - oldCenter.x, y: next.y + nextCenter.y - oldCenter.y }; });
      return;
    }
    const active = drag.current;
    if (!active) return;
    const dx = point.x - active.pointer.x, dy = point.y - active.pointer.y;
    if (Math.hypot(dx, dy) < 3 && !active.moved) return;
    active.moved = true; suppressedClick.current = true;
    if (!active.placement) { setView({ ...active.view, x: active.view.x + dx, y: active.view.y + dy }); return; }
    const definition = catalog.find((item) => item.key === active.placement?.item_key)!;
    let change = { x: dx / active.view.zoom / 48 + dy / active.view.zoom / 24, y: dy / active.view.zoom / 24 - dx / active.view.zoom / 48 };
    if (active.placement.zone === 'indoor' && house && houseDefinition) {
      const from = unprojectInterior({ x: (active.pointer.x - active.view.x) / active.view.zoom, y: (active.pointer.y - active.view.y) / active.view.zoom }, house, houseDefinition);
      const to = unprojectInterior({ x: (point.x - active.view.x) / active.view.zoom, y: (point.y - active.view.y) / active.view.zoom }, house, houseDefinition);
      change = { x: to.x - from.x, y: to.y - from.y };
    }
    const next = clampPlacement({ ...active.placement, x: active.placement.x + change.x, y: active.placement.y + change.y }, definition);
    if (canPlace(next, placements, catalog)) onMove(next); else onBlocked();
  }
  // 手势取消恢复拖动前的物品，双指结束后必须重新按下才开始单指拖动。
  function finish(event: PointerEvent<SVGSVGElement>, cancelled: boolean) {
    const active = drag.current;
    if (cancelled && active?.placement) onMove(active.placement);
    if (!cancelled && active?.targetID && !active.moved && pointers.current.size === 1) {
      if (editing) onSelect(active.targetID);
      else {
        const placement = placements.find((item) => item.id === active.targetID);
        if (catalog.find((item) => item.key === placement?.item_key)?.activity) onActivity(active.targetID);
      }
      suppressedClick.current = true;
    }
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  }
  // 键盘与触摸按钮提供拖动之外的完整视图操作。
  function keydown(event: KeyboardEvent<SVGSVGElement>) {
    if (event.target !== event.currentTarget) return;
    const offset = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[event.key];
    if (offset) { event.preventDefault(); setView((current) => ({ ...current, x: current.x + offset[0]!, y: current.y + offset[1]! })); }
    else if (['+', '=', '-', 'Home'].includes(event.key)) { event.preventDefault(); setView((current) => event.key === 'Home' ? fitIslandView(size.width, size.height, insets) : zoomAt(current, { x: size.width / 2, y: size.height / 2 }, event.key === '-' ? 0.85 : 1.15)); }
  }
  const visible = placements.filter((item) => catalog.find((entry) => entry.key === item.item_key)?.category !== 'environment' && (item.zone === 'outdoor' || houseOpen));
  const actorPoint = scenePoint(actor, actor.zone === 'indoor', house, houseDefinition);
  const layers = [...visible.map((placement) => ({ placement: placement as IslandPlacement | null, point: scenePoint(placement, placement.zone === 'indoor', house, houseDefinition), actor: false })), ...(actor.zone === 'outdoor' || houseOpen ? [{ placement: null, point: actorPoint, actor: true }] : [])];
  layers.sort((a, b) => {
    const layer = (entry: typeof a) => entry.actor && actor.zone === 'indoor' || entry.placement?.zone === 'indoor' ? 1 : 0;
    return layer(a) - layer(b) || a.point.y - b.point.y;
  });
  return <div className={`island-scene-shell ${editing ? 'island-scene-editing' : ''} ${dusk ? 'island-dusk' : ''}`}>
    <div className="island-view-controls" style={{ top: 'var(--island-hud-top, 100px)', right: Math.max(12, insets.right) }} aria-label={content.scene}>
      <button type="button" className="secondary" aria-label={content.zoomIn} onClick={() => setView((current) => zoomAt(current, { x: size.width / 2, y: size.height / 2 }, 1.2))}>＋</button>
      <button type="button" className="secondary" aria-label={content.zoomOut} onClick={() => setView((current) => zoomAt(current, { x: size.width / 2, y: size.height / 2 }, 1 / 1.2))}>−</button>
      <button type="button" className="secondary island-reset-view" aria-label={content.resetView} title={content.resetView} onClick={resetView}><svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M4 10V4m0 0h6M4 4l4 4a7 7 0 1 1-2 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
    </div>
    <svg ref={svg} viewBox={`0 0 ${size.width} ${size.height}`} className="island-scene" role="group" aria-label={content.scene} aria-describedby="island-scene-help" tabIndex={0}
      data-zoom={view.zoom.toFixed(3)} data-pan-x={view.x.toFixed(2)} data-pan-y={view.y.toFixed(2)} data-editing={editing}
      onPointerDown={start} onPointerMove={move} onPointerUp={(event) => finish(event, false)} onPointerCancel={(event) => finish(event, true)} onKeyDown={keydown}>
      <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
        <GroundArtwork />
        {layers.map((entry) => {
          if (entry.actor) return <g key="actor" transform={`translate(${entry.point.x} ${entry.point.y})`} data-actor-zone={actor.zone} data-actor-action={actor.action} aria-hidden="true" pointerEvents="none"><CharacterArtwork avatar={avatar} moving={actor.phase === 'walking'} activity={actor.action} facing={actor.facing} staticMotion={staticMotion} motionElapsed={actor.motionElapsed} /></g>;
          const placement = entry.placement!;
          const definition = catalog.find((item) => item.key === placement.item_key)!;
          const interactive = editing || Boolean(definition.activity);
          return <g key={placement.id} transform={`translate(${entry.point.x} ${entry.point.y})`} data-placement-id={placement.id} data-house-open={definition.category === 'house' ? houseOpen : undefined}
            className={interactive ? 'island-object-interactive' : undefined} role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined}
            aria-label={interactive ? `${editing ? content.select : content.activities[definition.activity!]} ${definition.name}` : undefined}
            onClick={(event) => { event.stopPropagation(); if (suppressedClick.current) { suppressedClick.current = false; return; } if (editing) onSelect(placement.id); else if (definition.activity) onActivity(placement.id); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (editing) onSelect(placement.id); else if (definition.activity) onActivity(placement.id); }
              const delta = { ArrowLeft: [-0.25, 0], ArrowRight: [0.25, 0], ArrowUp: [0, -0.25], ArrowDown: [0, 0.25] }[event.key];
              if (editing && delta && definition.movable) { event.preventDefault(); event.stopPropagation(); const next = clampPlacement({ ...placement, x: placement.x + delta[0]!, y: placement.y + delta[1]! }, definition); if (canPlace(next, placements, catalog)) onMove(next); else onBlocked(); }
            }}>
            <ItemArtwork houseScale={houseArtworkScale(definition)} model={definition.model} indoor={definition.category === 'house' && houseOpen} selected={editing && placement.id === selected} rotation={placement.rotation} {...(definition.animation ? { animation: definition.animation } : {})} staticMotion={staticMotion} />
          </g>;
        })}
      </g>
    </svg>
    <p id="island-scene-help" className="island-view-help">{editing ? content.editHelp : content.viewHelp}</p>
    <span className="island-sr-only">{content.keyboardHelp}</span>
  </div>;
}
