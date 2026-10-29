import type { ComponentType } from 'react';
import type { SceneDefinition } from './scene-definitions';
import { defaultScene } from './scene-definitions';
import { SceneSky, SeasideArtwork } from './SeasideArtwork';

// 整体场景的绘图读取地形定义与统一的动效开关。
export interface SceneArtworkProps {
  scene: SceneDefinition; // 绘图、地形查询和取景共用的数据。
  staticMotion: boolean; // 布置和减少动效使用静态图。
  motionPaused: boolean; // 暂停和后台保留动画相位。
}

// 天空使用屏幕尺寸，不参与地面相机变换。
export interface SceneSkyProps extends SceneArtworkProps {
  width: number; // 当前视口宽度。
  height: number; // 当前视口高度。
}

// 更换一个入口即替换背景、地形与取景；物品和角色仍由场景统一叠加。
export interface ScenePresentation {
  definition: SceneDefinition; // 与美术配套的世界数据。
  Ground: ComponentType<SceneArtworkProps>; // 地面渲染器。
  Sky: ComponentType<SceneSkyProps>; // 独立的天空渲染器。
}

export const defaultPresentation: ScenePresentation = { definition: defaultScene, Ground: SeasideArtwork, Sky: SceneSky };
