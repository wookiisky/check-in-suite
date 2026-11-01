import { useEffect } from 'react';
import type { ComponentProps } from 'react';
import type { CharacterPreview3D } from './features/character/CharacterPreview3D';

// 主应用业务测试保留真实Provider和编辑器，只替换WebGL绘制。
export function AppCharacterPreviewFake({snapshot,draft,onStatus}:ComponentProps<typeof CharacterPreview3D>){
  useEffect(()=>{onStatus?.({phase:'ready'});},[onStatus,draft]);
  return <output data-testid="app-character-preview">{JSON.stringify(draft??snapshot)}</output>;
}
