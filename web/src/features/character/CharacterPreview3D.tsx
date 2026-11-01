import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
export function CharacterPreview3D({ snapshot, draft, action = 'idle', paused = false, onStatus, className = '', label = content.label, attachments }: CharacterPreview3DProps) {
  const stopped = useGraphicsMotion(paused);
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
  return <section className={`character3d-preview ${className}`} aria-label={label} data-appearance-version={snapshot.version} data-character-key={draft?.character_key ?? snapshot.character_key} data-character-status={status.phase}>
    {!fatal && <CharacterCanvasBoundary key={canvasGeneration} onError={failed}>
      <Canvas orthographic shadows={{ type: PCFShadowMap }} dpr={[1, 1.5]} frameloop={stopped ? 'demand' : 'always'} camera={{ near: 0.1, far: 50 }} fallback={<p>{content.unsupported}</p>}>
        <PreviewEnvironment onError={failed} />
        <CharacterModel3D snapshot={snapshot} {...(draft ? { draft } : {})} {...(attachments ? { attachments } : {})} action={action} paused={stopped} onStatus={changed} attempt={attempt} />
      </Canvas>
    </CharacterCanvasBoundary>}
    {status.phase === 'loading' && <p className="character3d-notice" role="status">{content.loading}</p>}
    {status.phase === 'error' && <div className="character3d-notice character3d-error" role="alert"><p>{content.error}</p><button type="button" onClick={retry}>{content.retry}</button></div>}
  </section>;
}
