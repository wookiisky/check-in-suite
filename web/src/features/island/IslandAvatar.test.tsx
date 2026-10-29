import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IslandPage } from './IslandPage';
import { state } from './island-test-fixtures';
import { testSession } from '../../test/account-fixtures';
import { camp, purchase } from '../shop/test-fixtures';

describe('小岛角色与装扮一致', () => {
  it.each(['bear-v1', 'cat-v1', 'deer-v1', 'red-panda-v1'])('从营地读取 %s 后展示对应角色', async (assetKey) => {
    const equippedCamp = { ...camp, equipment: { ...camp.equipment, avatar: { ...purchase, type_snapshot: 'avatar', asset_key_snapshot: assetKey } } };
    const request = vi.fn().mockImplementation(async (path) => path === '/camp' ? equippedCamp : state);
    const { container } = render(<IslandPage client={{ request }} session={{ ...testSession, timezone: 'Asia/Taipei' }} />);
    await waitFor(() => expect(container.querySelector('.island-character-art image')).toHaveAttribute('href', `/api/v1/assets/${assetKey}`));
  });
});
