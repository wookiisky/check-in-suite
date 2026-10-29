import type { CSSProperties } from 'react';
import type { Equipment } from '../shop/types';
import { assetURL, portraitAssetKey } from '../shop/helpers';
import artwork from './character-artwork.json';

// 人类共用画布和身体锚点，动物继续使用各自的完整形象。
export function isHumanAvatar(key: string): boolean {
  return artwork.baseAvatars.some((item) => item.key === key);
}

// 同一组合用于画像、小岛和预览；调用方只控制整体位置与动作。
export function HumanCharacterArtwork({ baseAvatarKey, wearables, className, label, style, x, y, width = '100%', height = '100%' }: {
  baseAvatarKey: string; // 已校验的人类基础形象。
  wearables?: Equipment['wearables'] | undefined; // 未购买或脱下时恢复默认发型及基础衣物。
  className?: string; // 容器布局由使用场景决定。
  label?: string; // 装饰性缩略图省略名称，不重复朗读。
  style?: CSSProperties; // 画像将整个人物作为一个遮挡参照层。
  x?: number; // 小岛坐标以脚底为原点。
  y?: number; // 不改变内部服装坐标。
  width?: number | string; // 整体缩放，不允许单独调整穿戴部件。
  height?: number | string; // 统一320正方形画布。
}) {
  const base = artwork.baseAvatars.find((item) => item.key === baseAvatarKey)!;
  const hair = wearables?.hair;
  const hairBack = hair ? hair.back_asset_key : base.defaultHairBack;
  const layers = [
    { layer: 'hair-back', key: hairBack },
    { layer: 'body', key: baseAvatarKey },
    { layer: 'bottom', key: wearables?.bottom ? portraitAssetKey(wearables.bottom) : artwork.defaults.bottom },
    { layer: 'shoes', key: wearables?.shoes ? portraitAssetKey(wearables.shoes) : artwork.defaults.shoes },
    { layer: 'top', key: wearables?.top ? portraitAssetKey(wearables.top) : artwork.defaults.top },
    { layer: 'hair', key: hair ? portraitAssetKey(hair) : base.defaultHair },
  ];
  return <svg className={className} style={style} x={x} y={y} width={width} height={height} viewBox="0 0 320 320" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} data-base-avatar={baseAvatarKey}>
    {layers.map(({ layer, key }) => key && <image key={layer} data-character-layer={layer} href={assetURL(key)} width="320" height="320" />)}
  </svg>;
}
