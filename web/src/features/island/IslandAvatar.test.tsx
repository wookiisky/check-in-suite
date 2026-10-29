import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IslandPage } from './IslandPage';
import { state } from './island-test-fixtures';
import { testSession } from '../../test/account-fixtures';
import { camp, purchase } from '../shop/test-fixtures';
import { CharacterStage } from '../shop/CharacterStage';

describe('小岛角色与装扮一致', () => {
  it('读取营地的基础人物和穿戴，并与画像共用完整图层', async () => {
    const hair = { ...purchase, id: 'hair', asset_key_snapshot: 'hair-braids-v1', wearable_slot: 'hair' as const, back_asset_key: 'hair-braids-back-v1' };
    const top = { ...purchase, id: 'top', asset_key_snapshot: 'wearable-top-explorer-v1', wearable_slot: 'top' as const };
    const equipment = { ...camp.equipment, base_avatar_key: 'avatar-girl-v2', wearables: { ...camp.equipment.wearables, hair, top } };
    const request = vi.fn().mockImplementation(async (path) => path === '/camp' ? { ...camp, equipment } : state);
    const portrait = render(<CharacterStage equipment={equipment} />);
    const layers = (container: HTMLElement) => [...container.querySelectorAll('[data-character-layer]')].map((element) => ({ layer: element.getAttribute('data-character-layer'), asset: element.getAttribute('href') }));
    const expected = layers(portrait.container);
    expect(expected).toHaveLength(6);
    portrait.unmount();
    const island = render(<IslandPage client={{ request }} session={{ ...testSession, timezone: 'Asia/Taipei' }} />);
    await waitFor(() => expect(layers(island.container)).toEqual(expected));
    expect(island.container.querySelector('[data-base-avatar]')).toHaveAttribute('data-base-avatar', 'avatar-girl-v2');
  });
  it.each(['bear-v1', 'cat-v1', 'deer-v1', 'red-panda-v1'])('从营地读取 %s 后展示对应角色', async (assetKey) => {
    const equippedCamp = { ...camp, equipment: { ...camp.equipment, avatar: { ...purchase, type_snapshot: 'avatar', asset_key_snapshot: assetKey } } };
    const request = vi.fn().mockImplementation(async (path) => path === '/camp' ? equippedCamp : state);
    const { container } = render(<IslandPage client={{ request }} session={{ ...testSession, timezone: 'Asia/Taipei' }} />);
    await waitFor(() => expect(container.querySelector('.island-character-art image')).toHaveAttribute('href', `/api/v1/assets/${assetKey}`));
  });
});
