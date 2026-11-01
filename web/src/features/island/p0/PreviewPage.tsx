import { Component, Suspense, useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Canvas, useLoader } from '@react-three/fiber';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { useReducedMotion } from '../../shop/useReducedMotion';
import { houseSampleURLs } from './HouseSample';
import { PreviewScene } from './PreviewScene';
import type { PreviewJourney } from './PreviewScene';
import { rotateCamera } from './preview-space';
import content from './content.json';
import './preview-page.css';

/** 场景错误时，页面仍保留返回和重试操作。 */
interface SceneBoundaryProps {
  children: ReactNode; // 本次渲染会话。
  onFailure: () => void; // 让 HTML 区域反馈错误。
}

/** 场景渲染失败状态不写入业务状态。 */
interface SceneBoundaryState {
  failed: boolean; // 当前 Canvas 已停止渲染。
}

// WebGL 和模型加载异常只能终止样片场景，不能让整个页面失去操作。
class SceneBoundary extends Component<SceneBoundaryProps, SceneBoundaryState> {
  state: SceneBoundaryState = { failed: false }; // 新建会话时清除旧错误。
  static getDerivedStateFromError(): SceneBoundaryState { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? null : this.props.children; }
}

// 独立样片入口不读取账户，也不改写正式营地与外观。
export function PreviewPage() {
  const [direction, setDirection] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const [roofOpen, setRoofOpen] = useState(false);
  const [journey, setJourney] = useState<PreviewJourney>('outside');
  const [animation, setAnimation] = useState('Idle');
  const [userPaused, setUserPaused] = useState(false);
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden');
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reduced = useReducedMotion();
  const paused = userPaused || hidden || reduced;
  const moving = journey === 'entering' || journey === 'leaving';
  const onReady = useCallback(() => setReady(true), []);
  const onFailure = useCallback(() => { setFailed(true); setReady(false); }, []);
  const onArrived = useCallback(() => setJourney((value) => value === 'entering' ? 'inside' : 'outside'), []);
  useEffect(() => {
    const changed = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);

  // 重试重新创建 Canvas 并清除失败缓存，已下载的业务状态不受影响。
  function retry() {
    for (const url of [...houseSampleURLs, '/models/p0/kaykit/rogue.glb']) useLoader.clear(GLTFLoader, url);
    setReady(false); setFailed(false); setJourney('outside'); setAttempt((value) => value + 1);
  }

  // 按钮让鼠标、触屏与键盘共用相机动作。
  function moveCamera(x: number, z: number) {
    setPan(([currentX, currentZ]) => [Math.max(-7, Math.min(7, currentX + x)), Math.max(-7, Math.min(7, currentZ + z))]);
  }

  const status = failed ? content.error : !ready ? content.loading : reduced ? content.motionReduced : hidden ? content.hidden : userPaused ? content.paused : content.running;
  return <main className="p0-preview">
    <header className="p0-header">
      <div><p className="p0-eyebrow">{content.subtitle}</p><h1>{content.title}</h1></div>
      <a className="p0-back" href="/">{content.back}</a>
    </header>
    <p className="p0-description">{content.description}</p>
    <div className="p0-layout">
      <section className="p0-stage" aria-label={content.scene}>
        {!failed && <SceneBoundary key={attempt} onFailure={onFailure}>
          <Canvas orthographic shadows dpr={[1, 1.5]} frameloop={paused ? 'demand' : 'always'} camera={{ position: [10, 12, 10], zoom: 40, near: 0.1, far: 100 }} fallback={<div className="p0-unavailable" role="alert">{content.unsupported}</div>}>
            <Suspense fallback={null}>
              <PreviewScene direction={direction} zoom={zoom} pan={pan} roofOpen={roofOpen} journey={journey} animation={animation} paused={paused} onArrived={onArrived} onReady={onReady} onContextLost={onFailure} />
            </Suspense>
          </Canvas>
        </SceneBoundary>}
        <p className={`p0-status ${failed ? 'p0-status-error' : ''}`} role={failed ? 'alert' : 'status'} data-testid="p0-status">{status}</p>
        {failed && <button className="p0-retry" onClick={retry}>{content.retry}</button>}
      </section>
      <aside className="p0-controls">
        <fieldset disabled={!ready || failed}>
          <legend>{content.camera}</legend>
          <p className="p0-view-label" data-testid="p0-direction">{content.cameraDirections[direction]}</p>
          <div className="p0-button-grid">
            <button onClick={() => setDirection((value) => rotateCamera(value, -1))}>{content.rotateLeft}</button>
            <button onClick={() => setDirection((value) => rotateCamera(value, 1))}>{content.rotateRight}</button>
            <button onClick={() => setZoom((value) => Math.min(1.8, value + 0.15))}>{content.zoomIn}</button>
            <button onClick={() => setZoom((value) => Math.max(0.6, value - 0.15))}>{content.zoomOut}</button>
            <button onClick={() => moveCamera(-1, 0)}>{content.panLeft}</button>
            <button onClick={() => moveCamera(1, 0)}>{content.panRight}</button>
            <button onClick={() => moveCamera(0, -1)}>{content.panUp}</button>
            <button onClick={() => moveCamera(0, 1)}>{content.panDown}</button>
          </div>
          <button className="p0-full-button" onClick={() => { setDirection(0); setZoom(1); setPan([0, 0]); }}>{content.reset}</button>
        </fieldset>
        <fieldset disabled={!ready || failed}>
          <legend>{content.interior}</legend>
          <p data-testid="p0-journey">{content[journey]}</p>
          <button className="p0-full-button" aria-pressed={roofOpen || journey !== 'outside'} disabled={journey !== 'outside'} onClick={() => setRoofOpen((value) => !value)}>{roofOpen || journey !== 'outside' ? content.closeRoof : content.openRoof}</button>
          <button className="p0-full-button" disabled={moving || paused} onClick={() => setJourney(journey === 'inside' ? 'leaving' : 'entering')}>{journey === 'inside' || journey === 'leaving' ? content.leave : content.enter}</button>
        </fieldset>
        <fieldset disabled={!ready || failed}>
          <legend>{content.animation}</legend>
          <label className="p0-animation-label"><span>{content.animation}</span><select value={animation} disabled={moving} onChange={(event) => setAnimation(event.target.value)}>{content.animations.map((option) => <option key={option.clip} value={option.clip}>{option.label}</option>)}</select></label>
          <button className="p0-full-button" aria-pressed={userPaused} onClick={() => setUserPaused((value) => !value)}>{userPaused ? content.resume : content.pause}</button>
          <p className="p0-help">{content.independent}</p>
        </fieldset>
      </aside>
    </div>
  </main>;
}
