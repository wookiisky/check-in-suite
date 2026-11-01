import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Group, OrthographicCamera } from 'three';
import { CharacterSample } from '../../character/p0/CharacterSample';
import { sampleAppearanceCombinations } from '../../character/p0/sample-appearance';
import type { CharacterSampleDefinition, SampleAppearance } from '../../character/p0/sample-appearance';
import { previewAnimationURL } from './preview-character-assets';
import { HouseSample } from './HouseSample';
import { cameraPosition, doorRoute, moveAlongRoute } from './preview-space';
import type { PreviewPoint } from './preview-space';

export type PreviewJourney = 'outside' | 'entering' | 'inside' | 'leaving';

/** 相机操作保留在页面，逐帧运动保留在场景实例。 */
export interface PreviewSceneProps {
  direction: number; // 四向相机索引。
  zoom: number; // 有界缩放倍率。
  pan: [number, number]; // 相机平面的平移。
  roofOpen: boolean; // 手动打开室内。
  journey: PreviewJourney; // 人物进出阶段。
  animation: string; // 用户选择的原始动作名。
  paused: boolean; // 用户、页面和系统合并后的暂停状态。
  onArrived: () => void; // 角色到达路线端点。
  onReady: () => void; // 整个样片已完成首次加载。
  onContextLost: () => void; // 保留页面操作与重试入口。
  appearance: SampleAppearance; // 只用于主角色的四槽草稿。
  showCombinations: boolean; // 展示全部混搭组合。
  definition: CharacterSampleDefinition; // 与实际模型配套的人物描述。
}

// 方位旋转改变真实相机位置，平移始终依据当前相机的水平轴。
function PreviewCamera({ direction, zoom, pan, showCombinations }: Pick<PreviewSceneProps, 'direction' | 'zoom' | 'pan' | 'showCombinations'>) {
  const { camera, size, invalidate } = useThree();
  useEffect(() => {
    const [x, y, z] = cameraPosition(direction);
    const length = Math.hypot(x, z);
    const shiftX = z / length * pan[0] + x / length * pan[1];
    const shiftZ = -x / length * pan[0] + z / length * pan[1];
    const centerZ = showCombinations ? 0 : 1;
    camera.position.set(x + shiftX, y, z + shiftZ + centerZ);
    camera.lookAt(shiftX, 0, shiftZ + centerZ);
    if (camera instanceof OrthographicCamera) {
      camera.zoom = Math.min(size.width / (showCombinations ? 24 : 17), size.height / (showCombinations ? 19 : 13)) * zoom;
      camera.updateProjectionMatrix();
    }
    invalidate();
  }, [camera, direction, zoom, pan, size, invalidate, showCombinations]);
  return null;
}

// 进出只推进累计行程；恢复后的首帧被丢弃，不补算后台时间。
function WalkingSample({ journey, animation, paused, onArrived, appearance, definition }: Pick<PreviewSceneProps, 'journey' | 'animation' | 'paused' | 'onArrived' | 'appearance' | 'definition'>) {
  const group = useRef<Group>(null);
  const distance = useRef(0);
  const firstFrame = useRef(true);
  const arrived = useRef(false);
  const moving = journey === 'entering' || journey === 'leaving';
  const initial: PreviewPoint = journey === 'inside' || journey === 'leaving' ? [0, 0.1, 0] : [0, 0.1, 5];
  useEffect(() => {
    distance.current = 0; firstFrame.current = true; arrived.current = false;
    group.current?.position.set(...initial);
    if (group.current) group.current.rotation.y = journey === 'entering' ? Math.PI : 0;
  }, [journey]);
  useEffect(() => { firstFrame.current = true; }, [paused]);
  useFrame((_, delta) => {
    if (paused || !moving || !group.current || arrived.current) return;
    if (firstFrame.current) { firstFrame.current = false; return; }
    distance.current += Math.min(delta, 0.05) * 1.5;
    const state = moveAlongRoute(doorRoute(journey === 'entering'), distance.current);
    group.current.position.set(...state.position);
    group.current.rotation.y = state.facing;
    if (state.arrived) { arrived.current = true; onArrived(); }
  });
  return <group ref={group}>
    <CharacterSample definition={definition} appearance={appearance} animationUrl={previewAnimationURL} animation={moving ? 'Walking_A' : animation} paused={paused} />
  </group>;
}

// 场景就绪和 WebGL 丢失由 HTML 页面反馈，不把错误塞进三维文字。
function SceneLifecycle({ onReady, onContextLost }: Pick<PreviewSceneProps, 'onReady' | 'onContextLost'>) {
  const { gl } = useThree();
  useEffect(() => { onReady(); }, [onReady]);
  useEffect(() => {
    const lost = (event: Event) => { event.preventDefault(); onContextLost(); };
    gl.domElement.addEventListener('webglcontextlost', lost);
    return () => gl.domElement.removeEventListener('webglcontextlost', lost);
  }, [gl, onContextLost]);
  return null;
}

// 场景只有实际模型；地面与灯光用于观察尺寸和动作，不代表正式海边美术。
export function PreviewScene(props: PreviewSceneProps) {
  const combinations = useMemo(() => sampleAppearanceCombinations(props.definition), [props.definition]);
  return <>
    <color attach="background" args={['#dcebf0']} />
    <hemisphereLight args={['#fff5de', '#78936f', 2.5]} />
    <directionalLight position={[5, 12, 7]} intensity={2.3} castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-10} shadow-camera-right={10} shadow-camera-top={10} shadow-camera-bottom={-10} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
      <planeGeometry args={[30, 30]} /><meshStandardMaterial color="#a9bfa0" />
    </mesh>
    {props.showCombinations ? <group name="p0-combinations">
      {combinations.map((appearance, index) => <CharacterSample key={index} definition={props.definition} appearance={appearance} animationUrl={previewAnimationURL} animation={props.animation} paused={props.paused} position={[(index % 4) * 3.5 - 5.25, 0, Math.floor(index / 4) * 3.5 - 5.25]} />)}
    </group> : <>
      <HouseSample direction={props.direction} open={props.roofOpen || props.journey !== 'outside'} />
      <WalkingSample journey={props.journey} animation={props.animation} paused={props.paused} definition={props.definition} appearance={props.appearance} onArrived={props.onArrived} />
      <CharacterSample definition={props.definition} appearance={props.definition.defaults} animationUrl={previewAnimationURL} animation="Idle" paused={props.paused} position={[4.3, 0, 2.5]} rotation={-0.5} />
    </>}
    <PreviewCamera direction={props.direction} zoom={props.zoom} pan={props.pan} showCombinations={props.showCombinations} />
    <SceneLifecycle onReady={props.onReady} onContextLost={props.onContextLost} />
  </>;
}
