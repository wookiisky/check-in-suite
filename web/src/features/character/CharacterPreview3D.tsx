import { Component, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrthographicCamera, PCFShadowMap } from 'three';
import { useGraphicsMotion } from '../../graphics/useGraphicsMotion';
import { CharacterModel3D } from './CharacterModel3D';
import type { AppearanceDraft, AppearanceState, CharacterAttachment, CharacterLoadStatus } from './character3d-appearance';
import content from './character3d-content.json';
import './character3d-preview.css';

// 预览加载状态与保存事实分开，错误时保留普通 HTML 重试操作。
export interface CharacterPreview3DProps {
  snapshot: AppearanceState; // 当前服务器快照。
  draft?: AppearanceDraft; // 可选换装草稿。
  action?: string; // 目录中已整理好的语义动作。
  paused?: boolean; // 账户或页面暂停偏好。
  onStatus?: (status: CharacterLoadStatus) => void; // 供编辑器区分显示与保存状态。
  className?: string; // 宿主页面的布局样式。
  label?: string; // 该视图的可访问名称。
  attachments?: readonly CharacterAttachment[]; // 需要在预览中检查的活动道具。
  rotatable?: boolean; // 是否开放手动水平旋转。
  showRotationControls?: boolean; // 是否显示旋转按钮。
}

// 一次主指针拖动先确定方向，纵向意图交还给页面滚动。
interface PreviewDrag {
  pointerId: number; // 捕获的主指针。
  startX: number; // 判断拖动方向的起点。
  startY: number; // 判断纵向滚动的起点。
  lastX: number; // 上一帧横坐标。
  width: number; // 一次完整水平拖动对应一周。
  horizontal: boolean; // 超过阈值后锁定水平旋转。
}

// 角度保持在一周以内，不让连续拖动累积很大的弧度。
function normalizeRotation(angle: number) {
  const turn = 2 * Math.PI;
  return (angle % turn + turn) % turn;
}

// WebGL 初始化或渲染崩溃不能让保存与关闭等 HTML 操作一起消失。
class CharacterCanvasBoundary extends Component<{ children: ReactNode; onError: (error: unknown) => void }, { failed: boolean }> {
  state = { failed: false }; // 仅当前 Canvas 会话失败。
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.onError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

// 相机适配预览尺寸；上下文丢失交给外围 HTML，不依赖三维文字反馈。
function PreviewEnvironment({ onError }: { onError: (error: unknown) => void }) {
  const { camera, size, gl, invalidate } = useThree();
  useLayoutEffect(() => {
    camera.position.set(2.7, 2.5, 5); camera.lookAt(0, 0.9, 0);
    if (camera instanceof OrthographicCamera) { camera.zoom = Math.min(size.width / 3.1, size.height / 2.4); camera.updateProjectionMatrix(); }
    invalidate();
  }, [camera, size, invalidate]);
  useEffect(() => {
    const lost = (event: Event) => { event.preventDefault(); onError(new Error('CHARACTER_WEBGL_CONTEXT_LOST')); };
    gl.domElement.addEventListener('webglcontextlost', lost);
    return () => gl.domElement.removeEventListener('webglcontextlost', lost);
  }, [gl, onError]);
  return <>
    <hemisphereLight args={['#fff6df', '#657e68', 2.4]} />
    <directionalLight position={[3, 7, 5]} intensity={2.4} castShadow shadow-mapSize={[512, 512]} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.015, 0]} receiveShadow><circleGeometry args={[1.4, 48]} /><meshStandardMaterial color="#dbe7d2" roughness={1} /></mesh>
  </>;
}

// 所有业务页面复用单人物取景，但每个视图持有自己的 Canvas 与骨架实例。
export function CharacterPreview3D({ snapshot, draft, action = 'idle', paused = false, onStatus, className = '', label = content.label, attachments, rotatable = false, showRotationControls = true }: CharacterPreview3DProps) {
  const stopped = useGraphicsMotion(paused);
  const hintID = useId();
  const keyboardRotation = rotatable && !showRotationControls;
  const [rotation, setRotation] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<PreviewDrag | null>(null);
  const statusCallback = useRef(onStatus);
  useLayoutEffect(() => { statusCallback.current = onStatus; }, [onStatus]);
  const [attempt, setAttempt] = useState(0);
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  const [fatal, setFatal] = useState(false);
  const [status, setStatus] = useState<CharacterLoadStatus>({ phase: 'loading' });
  const changed = useCallback((next: CharacterLoadStatus) => { setStatus(next); }, []);
  const failed = useCallback((error: unknown) => { setFatal(true); setStatus({ phase: 'error', error }); }, []);
  useEffect(() => { statusCallback.current?.(status); }, [status]);
  const retry = () => {
    if (fatal) setCanvasGeneration((value) => value + 1);
    setFatal(false); setStatus({ phase: 'loading' }); setAttempt((value) => value + 1);
  };

  // 松手、取消和捕获丢失共用终止路径，避免后续移动继续转动人物。
  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  // HTML 重试按钮不参与拖动；浏览器仍可接管纵向滚动和双指缩放。
  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    if (!rotatable || !event.isPrimary || event.button !== 0 || drag.current || (event.target instanceof Element && event.target.closest('button'))) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, width: event.currentTarget.getBoundingClientRect().width, horizontal: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  // 拖过整个预览宽度转一周，仅更新朝向，不触发换装或保存。
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!rotatable || !current || current.pointerId !== event.pointerId) return;
    if (!current.horizontal) {
      const dx = Math.abs(event.clientX - current.startX), dy = Math.abs(event.clientY - current.startY);
      if (Math.max(dx, dy) < 6) return;
      if (dy >= dx) { endDrag(event); return; }
      current.horizontal = true; setDragging(true);
    }
    const delta = (event.clientX - current.lastX) / current.width * Math.PI * 2;
    current.lastX = event.clientX;
    setRotation((value) => normalizeRotation(value + delta));
  }

  // 只有预览本身获得焦点时才接管方向键和 Home。
  function rotateWithKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Home') setRotation(0);
    else if (event.key === 'ArrowLeft') setRotation((value) => normalizeRotation(value - Math.PI / 4));
    else if (event.key === 'ArrowRight') setRotation((value) => normalizeRotation(value + Math.PI / 4));
    else return;
    event.preventDefault();
  }

  return <section className={`character3d-preview ${rotatable ? 'character3d-rotatable' : ''} ${className}`} aria-label={label} aria-describedby={rotatable ? hintID : undefined} tabIndex={keyboardRotation ? 0 : undefined} onKeyDown={keyboardRotation ? rotateWithKeyboard : undefined} data-appearance-version={snapshot.version} data-character-key={draft?.character_key ?? snapshot.character_key} data-character-status={status.phase} data-character-action={action} data-character-rotation={rotatable ? rotation : 0}>
    <div className={`character3d-stage ${dragging ? 'character3d-dragging' : ''}`} onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      {!fatal && <CharacterCanvasBoundary key={canvasGeneration} onError={failed}>
        <Canvas orthographic shadows={{ type: PCFShadowMap }} dpr={[1, 1.5]} frameloop={stopped ? 'demand' : 'always'} camera={{ near: 0.1, far: 50 }} style={rotatable ? { touchAction: 'pan-y pinch-zoom' } : {}} fallback={<p>{content.unsupported}</p>}>
          <PreviewEnvironment onError={failed} />
          <CharacterModel3D snapshot={snapshot} {...(draft ? { draft } : {})} {...(attachments ? { attachments } : {})} rotation={rotatable ? rotation : 0} action={action} paused={stopped} onStatus={changed} attempt={attempt} />
        </Canvas>
      </CharacterCanvasBoundary>}
      {status.phase === 'loading' && <p className="character3d-notice" role="status">{content.loading}</p>}
      {status.phase === 'error' && <div className="character3d-notice character3d-error" role="alert"><p>{content.error}</p><button type="button" onClick={retry}>{content.retry}</button></div>}
    </div>
    {rotatable && <p className="sr-only" id={hintID}>{keyboardRotation ? content.rotation.keyboardHint : content.rotation.hint}</p>}
    {rotatable && showRotationControls && <div className="character3d-rotation-controls">
      <div className="character3d-rotation-buttons">
        <button type="button" onClick={() => setRotation((value) => normalizeRotation(value - Math.PI / 4))}>{content.rotation.left}</button>
        <button type="button" onClick={() => setRotation(0)}>{content.rotation.reset}</button>
        <button type="button" onClick={() => setRotation((value) => normalizeRotation(value + Math.PI / 4))}>{content.rotation.right}</button>
      </div>
    </div>}
  </section>;
}
