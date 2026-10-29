import type { CSSProperties } from 'react';
import { assetURL } from '../shop/helpers';
import type { IslandDefinition } from './island-types';
import { IslandObjectArtwork, supportsObjectArtwork } from './IslandObjectArtwork';
import './island-art.css';
import type { Equipment } from '../shop/types';
import { HumanCharacterArtwork, isHumanAvatar } from '../character/HumanCharacterArtwork';

// 美术只描绘模型，位置、遮挡顺序和交互由场景统一管理。
interface ItemArtworkProps {
  model: string; // 受控物品目录选择的模型名称。
  indoor?: boolean; // 房屋展开时只保留地板和后墙。
  selected?: boolean; // 选择环不参与地面占用判断。
  houseScale?: number; // 房屋模型与服务端占地采用相同比例。
  rotation?: number; // 固定视角下按朝向镜像，不旋转摄像机。
  animation?: IslandDefinition['animation']; // 可选动作能力，模型存在不代表必须播放动画。
  staticMotion?: boolean; // 编辑或减少动效时展示静态模型。
  motionPaused?: boolean; // 暂停或隐藏时保留当前动画相位。
}

// 角色各肢体独立绘制，使动作不依赖整幅画像的位移。
interface CharacterArtworkProps {
  avatar: string; // 与画像同步的受控素材标识；狐狸和兔子继续使用肢体动画。
  wearables?: Equipment['wearables'] | undefined; // 固定穿戴和人物整体使用同一动作变换。
  moving: boolean; // 地面移动时启用走路动作。
  activity: 'idle' | 'walk' | 'rest' | 'read' | 'run' | 'ball'; // 动作表现，不决定业务行为。
  facing?: number; // 负数朝左，其他值朝右。
  staticMotion?: boolean; // 减少动效时仍保留可识别的活动姿态。
  motionElapsed?: number; // 累计动画时间决定姿势，遮挡重排不会重新开始动作。
}

// 房屋剖面保留后墙与地板，室内家具由场景按深度放入。
function HouseArtwork({ indoor, cottage }: { indoor: boolean; cottage: boolean }) {
  const roof = cottage ? '#b96655' : '#ca886b';
  return <g stroke="#786c50" strokeWidth="2.3" strokeLinejoin="round">
    <ellipse cy="10" rx="76" ry="34" fill="#50734a" opacity=".16" stroke="none" />
    <path d="M-72-4 0-39 72-4 0 31Z" fill="#e4c7a0" />
    <path d="M-72-4 0 31V37L-72 2Z" fill="#bda079" /><path d="M0 31 72-4V2L0 37Z" fill="#c9ae82" />
    <path d="M-65-7V-66L0-96V-37Z" fill="#e9dec1" /><path d="M0-96 65-66V-7L0-37Z" fill="#f8efd6" />
    <path d="M-65-7 0-37 65-7 0 24Z" fill="#dfc49c" />
    <g stroke="#be9d77" strokeWidth="1" opacity=".7"><path d="m-48 1 64-31m-48 38 64-31m-48 38 64-31m-48 38 64-31" /></g>
    <g transform="translate(33 -57)"><path d="M-12-14 12-3V19L-12 8Z" fill="#a9d2cc" /><path d="M0-9V14m-12-17L12 8" stroke="#f5edcf" strokeWidth="3" /></g>
    <path d="m-46-59 20-9v22l-20 9Z" fill="#f4dfb1" stroke="#b59565" /><path d="m-41-53 10-5m-10 11 12-5" stroke="#c5a372" strokeWidth="1.4" />
    {!indoor && <>
      <path d="M-65-66 0-35V24L-65-7Z" fill="#f1e4bf" /><path d="M0-35 65-66V-7L0 24Z" fill="#d9c79d" />
      <g transform="scale(-1 1)">
      <path d="M18 15V-20Q18-35 32-40Q46-44 46-29V2Z" fill="#8caa9a" /><path d="M24 9V-20q0-10 8-13t8 9V1" fill="#a4beb0" strokeWidth="1.5" /><circle cx="38" cy="-11" r="2" fill="#edca6c" stroke="none" />
      <path d="m-51-45 29 14v23l-29-14Z" fill="#b5d9d1" /><path d="m-37-38v24m-14-20 29 14" stroke="#faf1d5" strokeWidth="3" /><path d="m-55-20 38 18v5l-38-18Z" fill="#9d8361" />
      </g>
      <path d="M-78-68-22-119 9-105 0-31Z" fill={roof} /><path d="M-22-119 78-73 0-31 9-105Z" fill={cottage ? '#dc8971' : '#e4a17e'} />
      <path d="m-78-68 78 37 78-42" fill="none" stroke="#79664e" strokeWidth="5" strokeLinecap="round" />
      <path d="m-22-119 100 46" stroke={cottage ? '#f2b29a' : '#f1c09b'} strokeWidth="4" strokeLinecap="round" />
      <g stroke={cottage ? '#a75b4c' : '#ba7f64'} strokeWidth="1.5" opacity=".65"><path d="m-7-112 1 68m23-57-4 47m27-36-7 24m-76-30 71 33m-85-19 64 30" /></g>
      <path d="M38-98V-121L50-127 63-121V-86" fill="#e6cfab" /><path d="m50-127v24m-12-18 12 6 13-6" fill="none" /><path d="m36-122 14-8 16 8-15 8Z" fill="#f1dfbd" />
      <g strokeWidth="1.4" transform="scale(-1 1)"><path d="m-43-11 16 7-3 10-12-6Z" fill="#bb8767" /><path d="m-37-11-6-9m6 9 4-13m-4 13 9-5" stroke="#618359" strokeWidth="4" strokeLinecap="round" /></g>
    </>}
    <g transform="scale(-1 1)"><path d="m18 22 25-12 11 5-26 13Z" fill="#cdb18a" /><path d="m28 28 26-13v5L28 33Z" fill="#bca17d" /></g>
  </g>;
}

// 可选能力缺失时物品仍以静态模型完整展示。
export function ItemArtwork({ model, indoor = false, selected = false, rotation = 0, houseScale = 2, animation, staticMotion = false, motionPaused = false }: ItemArtworkProps) {
  const mirror = ((rotation % 360) + 360) % 360 >= 180 ? -1 : 1;
  return <g className="island-item-art" data-animation={animation} data-static={staticMotion} data-paused={motionPaused}>
    {selected && <ellipse cy="6" rx={model === 'house' || model === 'cottage' ? 84 * houseScale : 35} ry={model === 'house' || model === 'cottage' ? 40 * houseScale : 17} fill="#fff8c5" fillOpacity=".45" stroke="#735c2d" strokeWidth="2" strokeDasharray="5 4" />}
    <g transform={`scale(${mirror} 1)`}>
      {supportsObjectArtwork(model) ? <IslandObjectArtwork model={model} /> : model.startsWith('island-') && <image href={assetURL(model)} x={-60} y={-99.375} width={120} height={120} />}
      {(model === 'house' || model === 'cottage') && <g transform={`scale(${houseScale})`}><HouseArtwork indoor={indoor} cottage={model === 'cottage'} /></g>}
      {model === 'tree' && <g stroke="#67794b" strokeWidth="2" strokeLinejoin="round">
        <ellipse cy="3" rx="30" ry="12" fill="#527749" opacity=".2" stroke="none" />
        <path d="M-5 0-4-38 5-38 6 1Z" fill="#b89165" /><path d="M0-16 14-29m-14 6-12-10" fill="none" stroke="#997950" />
        <g className="island-tree-crown"><path d="M-28-29Q-43-47-27-57Q-29-78-10-79Q1-94 16-78Q37-76 32-57Q46-44 31-30Q12-19-4-28Q-16-20-28-29Z" fill="#8daf6e" /><path d="M-29-52Q-25-70-10-66Q-1-84 14-71Q30-69 26-55" stroke="#b4cd89" strokeWidth="6" strokeLinecap="round" fill="none" /><path d="M-20-38q9 6 17 0m13-4q8 4 14-2" stroke="#739556" fill="none" /></g>
        <path d="m-11 1 4-6m13 6 5-7" stroke="#77935a" strokeLinecap="round" />
      </g>}
      {model === 'desk' && <g stroke="#806b4e" strokeWidth="2" strokeLinejoin="round">
        <ellipse cy="6" rx="33" ry="14" fill="#50734a" opacity=".15" stroke="none" />
        <path d="M-26-17V3l5 3v-20m40-1V8l5-2v-22M-2-4v19l5-2V-7" fill="#bb9264" />
        <path d="m-31-24 27-13 36 18L4-5Z" fill="#e2ba83" /><path d="M-31-24V-18L4-1v-4Z" fill="#ba8b5b" /><path d="M4-5 32-19V-13L4-1Z" fill="#cd9f6b" />
        <path d="m-18-23 12-6 11 5 12-4 10 6-15 7-11-5-10 5Z" fill="#fff4cf" strokeWidth="1.3" /><path d="m5-24 7 9" stroke="#b89a6b" strokeWidth="1" /><path d="m-10-23 5-2m0 5 5-2m11 1 6-3" stroke="#b7aa88" strokeWidth="1" />
        <path d="m-21-28 5-2v-10l-5 2Z" fill="#9bbab1" /><path d="m-19-39 2-6" stroke="#c28b55" />
      </g>}
      {model === 'book' && <g stroke="#806b4e" strokeWidth="1.5" strokeLinejoin="round">
        <ellipse cy="3" rx="28" ry="11" fill="#50734a" opacity=".16" stroke="none" />
        <path d="m-29-5 22-11 37 18L8 13Z" fill="#caa77a" /><path d="M-29-5V-1L8 17v-4Z" fill="#ad875f" /><path d="M8 13 30 2V6L8 17Z" fill="#b99568" />
        <path d="m-25-8 16-9 15 6 15-6 9 13L9 7-6 1-19 7Z" fill="#8ea99a" />
        <path d="m-22-10 13-9 15 7 13-6 8 12L9 4-5-2-17 4Z" fill="#fff1ce" />
        <path d="m6-12 3 16" fill="none" stroke="#c6aa7c" /><path d="m-14-11 7-3m-4 7 7-3m17-1 6-3m-3 7 7-3" fill="none" stroke="#b7a47c" strokeWidth="1.1" />
        <path d="m6-11 3 15 3-1 1 5-4-2-2 3-2-19Z" fill="#d99071" stroke="none" />
      </g>}
      {(model === 'run' || model === 'track' || model === 'running') && <g strokeLinejoin="round">
        <path d="M-47-7 1-30 49-7 1 18Z" fill="#d3b187" stroke="#a68b64" strokeWidth="2" />
        <path d="m-34-7 35-17 35 17L1 10Z" fill="none" stroke="#faeaca" strokeWidth="3" />
        <path d="m-20-7 21-10 21 10L1 3Z" fill="#a9c183" stroke="#f9e6c6" strokeWidth="2" />
        <g stroke="#8d7b57" strokeWidth="1.5"><path d="m-35-5 3-12 7 10Z" fill="#d99068" /><path d="m24-8 3-12 7 10Z" fill="#e5ac73" /><path d="m-32-12 5 3m-2-6 5 2" stroke="#fff0ce" /></g>
      </g>}
      {model === 'ball' && <g stroke="#9b7550" strokeWidth="1.7">
        <ellipse cy="3" rx="22" ry="9" fill="#50734a" opacity=".16" stroke="none" />
        <circle cy="-10" r="14" fill="#efbe79" /><path d="M-14-10h28M0-24Q-12-10 0 4M0-24Q12-10 0 4" fill="none" /><path d="M-9-16q4-5 10-4" stroke="#ffe3a3" strokeWidth="3" strokeLinecap="round" />
      </g>}
      {model === 'butterfly' && <g className="island-butterfly-float">
        <ellipse cy="3" rx="12" ry="5" fill="#50734a" opacity=".12" />
        <g transform="translate(0 -32)"><g className="island-butterfly-wings" stroke="#9d7b63" strokeWidth="1.3"><path d="M0 0C-29-32-28 13-3 5C-20 20 0 25 0 5" fill="#f2c28e" /><path d="M0 0C29-32 28 13 3 5C20 20 0 25 0 5" fill="#f4d7a1" /><path d="m-4-1-9-8m17 8 9-8" stroke="#d99d7b" /></g><path d="M0-6V8m0-12-5-6m5 6 5-6" stroke="#8b7560" strokeWidth="2" strokeLinecap="round" /></g>
      </g>}
      {(model === 'flower' || model === 'planter') && <g stroke="#806b4e" strokeWidth="1.7"><ellipse cy="2" rx="17" ry="7" fill="#50734a" opacity=".15" stroke="none" /><path d="m-14-13 5 16H9l5-16Z" fill="#c58e6f" /><ellipse cy="-13" rx="15" ry="6" fill="#e3ad83" /><path d="M0-14V-34m0 12-12-7m12 2 10-7" stroke="#6f9459" strokeWidth="4" strokeLinecap="round" /><g fill="#f4d69f"><circle cy="-36" r="7" /><circle cx="-10" cy="-30" r="6" /><circle cx="10" cy="-34" r="5" /></g><circle cy="-36" r="2.5" fill="#d9a45c" stroke="none" /></g>}
      {model === 'lamp' && <g stroke="#7f7154" strokeWidth="2"><ellipse cy="2" rx="16" ry="6" fill="#50734a" opacity=".14" stroke="none" /><path d="M-3 0V-44H3V0Z" fill="#b79a70" /><path d="m-10-45 3-20H7l3 20Z" fill="#fff0bb" /><path d="m-13-66 13-8 13 8Z" fill="#88a28a" /><path d="M-9-44H9" strokeWidth="4" strokeLinecap="round" /></g>}
    </g>
  </g>;
}

// 动画只改变局部姿势，角色世界位置与朝向由外层控制。
export function CharacterArtwork({ avatar, wearables, moving, activity, facing = 1, staticMotion = false, motionElapsed = 0 }: CharacterArtworkProps) {
  const bunny = avatar === 'bunny' || avatar === 'bunny-v1';
  const human = isHumanAvatar(avatar);
  const motionStyle = { '--island-motion-delay': `${-motionElapsed}s` } as CSSProperties;
  const book = activity === 'read' && <g className="island-character-book" transform={human ? 'translate(0 -24)' : undefined}><path d="m-16-21 16 5 15-6 1 17L0 1-15-4Z" fill="#fff0c4" /><path d="M0-16V1m-11-17 6 2m-6 3 6 2m11-7 5-2m-5 7 5-2" stroke="#c7a77a" strokeWidth="1" /></g>;
  const ball = activity === 'ball' && <g className="island-character-ball"><circle cx="25" cy="-4" r="9" fill="#f0c17e" /><path d="M16-4h18m-9-9q-7 9 0 18m0-18q7 9 0 18" fill="none" strokeWidth="1" /></g>;
  // 图片角色共用活动时钟与道具；动作放在镜像内层，避免覆盖朝向和地面位置。
  if (!bunny && avatar !== 'fox' && avatar !== 'fox-v1') {
    return <g className="island-character-art" data-moving={moving} data-activity={activity} data-static={staticMotion} style={motionStyle}>
      {human && <ellipse cy="3" rx="15" ry="5" fill="#496943" opacity=".2" />}
      <g transform={`scale(${facing < 0 ? -1 : 1} 1)`} stroke="#7b6550" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
        <g className="island-character-image-body">
          {human
            ? <HumanCharacterArtwork baseAvatarKey={avatar} wearables={wearables} x={-50} y={-93.75} width={100} height={100} />
            : <image href={assetURL(avatar)} x={-50} y={-93.75} width={100} height={100} />}
          {book}
        </g>
        {ball}
      </g>
    </g>;
  }
  const fur = bunny ? '#f7efd9' : '#e4a06a';
  const outline = bunny ? '#647151' : '#7b6550';
  return <g className="island-character-art" data-moving={moving} data-activity={activity} data-static={staticMotion} style={motionStyle}>
    <ellipse cy="3" rx="20" ry="7" fill="#496943" opacity=".23" />
    <g transform={`scale(${facing < 0 ? -1 : 1} 1)`} stroke={outline} strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
      <g className="island-character-body">
        {!bunny && <g className="island-character-tail"><path d="M12-12Q36-10 31-32Q28-42 39-44Q30-54 21-39Q13-29 8-23Z" fill={fur} /><path d="M31-32Q28-42 39-44Q32-49 28-44Q25-38 26-34Z" fill="#fff0d7" /></g>}
        {bunny && <><circle cx="16" cy="-10" r="7" fill="#fff7e8" /><path d="M12-32q17-6 18 8v17l-17 2Z" fill="#c99761" /><path d="m23-25 5 2m-4 8 5 1" stroke="#a77a50" /></>}
        <g className="island-character-leg island-character-leg-left"><path d="M-12-13Q-20 0-13 1H-3L-2-10Z" fill={fur} /></g>
        <g className="island-character-leg island-character-leg-right"><path d="M4-13Q5 0 13 1H19Q23-3 13-13Z" fill={fur} /></g>
        <path d="M-10-35Q-20-24-17-9Q1-1 19-10Q17-28 9-35Z" fill={bunny ? '#7ca36b' : fur} />
        {bunny ? <path d="m-7-32 7 21 9-22Z" fill="#e9d49a" /> : <path d="M-5-28Q-13-18-8-10Q1-6 9-12Q9-24 4-28Z" fill="#ffefd5" strokeWidth="1" />}
        <g className="island-character-head">
          {bunny ? <><path d="M-12-50Q-28-83-17-86Q-9-84-4-53m10 0Q6-90 16-88Q27-85 16-50" fill={fur} /><path d="M-15-62q-7-17-3-18M13-62q-1-17 2-19" stroke="#e9bdb0" strokeWidth="4" /></> : <><path d="M-17-47Q-28-66-23-72Q-11-71-5-57M8-57Q17-74 26-72Q29-59 18-47" fill={fur} /><path d="m-20-64 3 10 5-4m26 0 7-7-2 12" fill="#a9745c" strokeWidth="1" /></>}
          <path d={bunny ? 'M-18-53Q-32-38-19-29Q0-18 19-30Q30-42 18-54Q0-65-18-53Z' : 'M-17-56Q0-65 18-55L25-42 30-38 23-35Q15-21 0-22Q-15-21-24-35L-30-38-24-42Z'} fill={fur} />
          {!bunny && <path d="M-24-39Q-12-41-3-32L0-30 3-32Q14-42 24-39Q17-22 0-22Q-16-23-24-39Z" fill="#fff0d6" strokeWidth="1" />}
          <path d="M-12-45v3m24-3v3" strokeWidth="3" />
          <path d="m-3-35 3 3 3-3Z" fill={bunny ? '#b38675' : outline} strokeWidth="1" /><path d="M-5-28q5 4 10 0" fill="none" strokeWidth="1.2" />
          <ellipse cx="-18" cy="-36" rx="4" ry="2.5" fill="#e8aa90" opacity=".7" stroke="none" /><ellipse cx="18" cy="-36" rx="4" ry="2.5" fill="#e8aa90" opacity=".7" stroke="none" />
        </g>
        {!bunny && <><path d="m-12-28 12 5 14-5 2 6-16 6-13-5Z" fill="#8aa9a0" /><path d="m1-17 8 3-1 14-6-4-3 1Z" fill="#8aa9a0" /></>}
        <g className="island-character-arm island-character-arm-left"><path d="M-15-24q-13 3-10 10 4 5 12-2" fill={fur} /></g>
        <g className="island-character-arm island-character-arm-right"><path d="M15-24q12 3 9 10-5 4-12-3" fill={fur} /></g>
        {book}
        {activity === 'rest' && <path d="M-12-44h5m14 0h5" stroke={outline} strokeWidth="3" />}
      </g>
      {ball}
    </g>
  </g>;
}
