import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HumanCharacterArtwork } from './HumanCharacterArtwork';
import { equipment, purchase } from '../shop/test-fixtures';

// 验证真正的组合结果与遮挡顺序，不依赖整张人物图片。
describe('人类固定穿戴绘制', () => {
  it.each(['avatar-boy-v2', 'avatar-girl-v2'])('%s 在没有购买装备时也有头发和完整基础衣物', (baseAvatarKey) => {
    const { container } = render(<HumanCharacterArtwork baseAvatarKey={baseAvatarKey} />);
    for (const layer of ['body', 'bottom', 'shoes', 'top', 'hair']) {
      expect(container.querySelector(`[data-character-layer="${layer}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-character-layer="body"]')).toHaveAttribute('href', `/api/v1/assets/${baseAvatarKey}`);
  });

  it('长发前后层一起替换，衣物替换默认层且顺序固定', () => {
    const hair = { ...purchase, id: 'hair', asset_key_snapshot: 'hair-braids-v1', wearable_slot: 'hair' as const, back_asset_key: 'hair-braids-back-v1' };
    const top = { ...purchase, id: 'top', asset_key_snapshot: 'wearable-top-explorer-v1', wearable_slot: 'top' as const };
    const { container, rerender } = render(<HumanCharacterArtwork baseAvatarKey="avatar-boy-v2" wearables={{ ...equipment.wearables, hair, top }} />);
    const layers = () => [...container.querySelectorAll('[data-character-layer]')];
    expect(layers().map((element) => element.getAttribute('data-character-layer'))).toEqual(['hair-back', 'body', 'bottom', 'shoes', 'top', 'hair']);
    expect(container.querySelector('[data-character-layer="top"]')).toHaveAttribute('href', '/api/v1/assets/wearable-top-explorer-v1');
    expect(container.querySelectorAll('[data-character-layer="top"]')).toHaveLength(1);
    expect(container.querySelector('[data-character-layer="hair-back"]')).toHaveAttribute('href', '/api/v1/assets/hair-braids-back-v1');
    rerender(<HumanCharacterArtwork baseAvatarKey="avatar-girl-v2" wearables={{ ...equipment.wearables, hair, top }} />);
    expect(container.querySelector('[data-character-layer="hair"]')).toHaveAttribute('href', '/api/v1/assets/hair-braids-v1');
    rerender(<HumanCharacterArtwork baseAvatarKey="avatar-boy-v2" />);
    expect(container.querySelector('[data-character-layer="hair-back"]')).toBeNull();
    expect(container.querySelector('[data-character-layer="top"]')).toHaveAttribute('href', '/api/v1/assets/default-top-v1');
  });
});
