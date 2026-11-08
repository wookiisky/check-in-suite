import type { ComponentProps } from 'react';
import { useAppearance } from './AppearanceProvider';
import type { CharacterPreview3D } from './CharacterPreview3D';
import { appearanceFixture } from '../shop/appearance-test-fixtures';

// DOM 测试只观察共享快照与暂停参数；真实 WebGL 继续由浏览器验证。
export function PanelPreviewFake({ snapshot, paused, rotatable, showRotationControls }: ComponentProps<typeof CharacterPreview3D>) {
  return <output data-testid="saved-character-preview">{JSON.stringify({ snapshot, paused, rotatable, showRotationControls })}</output>;
}

// 保存发生在外观编辑器，首页应直接响应共享发布而无需重读聚合数据。
export function PublishPanelAppearance() {
  const { publishSaved, refresh } = useAppearance();
  return <><button onClick={() => publishSaved(appearanceFixture(2))}>发布外观快照</button><button onClick={() => void refresh()}>刷新外观快照</button></>;
}
