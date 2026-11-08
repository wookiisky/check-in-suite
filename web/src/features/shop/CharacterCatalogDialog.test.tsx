import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppearanceDialog } from './AppearanceDialog';
import { appearanceClient, appearanceFixture } from './appearance-test-fixtures';
import { ApiFailure } from '../../api/client';

vi.mock('../character/CharacterPreview3D', async () => {
  const { AppearancePreviewFake } = await import('./appearance-test-fixtures');
  return { CharacterPreview3D: AppearancePreviewFake };
});

// 共用身体的角色仍有独立购买身份，测试库存不受商品列表限制。
function characterCatalogFixture() {
  const state = appearanceFixture();
  const base = { ...state.characters[0]!, body_key: 'shared-body', thumbnail_url: '/base.png' };
  return {
    ...state,
    default_character_key: base.character_key,
    head_wearable_key: 'head-owned' as string | null,
    characters: [base, { ...base, character_key: 'owned-knight', name: '已购骑士', thumbnail_url: '/knight.png' }, { ...base, character_key: 'locked-mage', name: '未购法师' }],
    wearables: state.wearables.map((item) => ({ ...item, body_key: 'shared-body' })),
    character_inventory: [{ character_key: 'owned-knight' }],
  };
}

describe('完整人物与共享服装', () => {
  it('只显示默认和已购人物，切换仅改变草稿并重置六槽，再次选择原有服装可一起保存', async () => {
    const state = characterCatalogFixture();
    const fake = appearanceClient(async (_path, options) => options.method === 'PUT' ? { ...state, ...options.body as object, version: 2 } : state);
    const onSaved = vi.fn();
    render(<AppearanceDialog client={fake.client} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('radio', { name: '已购骑士' }));
    expect(screen.queryByRole('radio', { name: '未购法师' })).not.toBeInTheDocument();
    expect(screen.getByTestId('appearance-preview-draft')).toHaveTextContent('owned-knight');
    expect(screen.getByTestId('appearance-preview-draft')).not.toHaveTextContent('head-owned');
    expect(fake.request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
    fireEvent.click(screen.getByRole('radio', { name: '头部新款' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(fake.request).toHaveBeenCalledWith('/appearance', expect.objectContaining({ method: 'PUT', body: {
      expected_version: 1, character_key: 'owned-knight', face_wearable_key: null, back_wearable_key: null, head_wearable_key: 'head-owned', upper_wearable_key: null, lower_wearable_key: null, shoes_wearable_key: null,
    } }));
  });

  it('不同身体或骨架的服装不能出现在共用换装列表，取消不保存人物切换', async () => {
    const state = characterCatalogFixture();
    state.wearables = state.wearables.map((item) => item.slot === 'upper' ? { ...item, body_key: 'other-body' } : item.slot === 'shoes' ? { ...item, rig_key: 'other-rig' } : item);
    const fake = appearanceClient(async () => state);
    const onClose = vi.fn();
    render(<AppearanceDialog client={fake.client} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('radio', { name: '已购骑士' }));
    expect(screen.queryByRole('radio', { name: '上装新款' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '鞋子新款' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fake.request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
  });

  it('已拥有骷髅的基础形象可以在其他兼容身体上选择，无需服装订单', async () => {
    const state = characterCatalogFixture();
    state.characters[1]!.defaults = { ...state.characters[1]!.defaults, face: 'face-owned' };
    state.inventory = state.inventory.filter((item) => item.wearable_key !== 'face-owned');
    const fake = appearanceClient(async (_path, options) => options.method === 'PUT' ? { ...state, ...options.body as object, version: 2 } : state);
    const onSaved = vi.fn();
    render(<AppearanceDialog client={fake.client} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('radio', { name: '形象新款' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(fake.request).toHaveBeenCalledWith('/appearance', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ character_key: 'body-fixture', face_wearable_key: 'face-owned' }) }));
  });

  it('初始免费服装可用于购买人物，重新选择购买服装会清除免费选择', async () => {
    const state = characterCatalogFixture();
    const upper = state.wearables.find((item) => item.wearable_key === 'upper-default')!;
    state.wearables.push({ ...upper, wearable_key: 'knight-upper', name: '骑士上装' });
    state.characters[1]!.defaults = { ...state.characters[1]!.defaults, upper: 'knight-upper' };
    const fake = appearanceClient(async (_path, options) => options.method === 'PUT' ? { ...state, ...options.body as object, version: 2 } : state);
    const onSaved = vi.fn();
    render(<AppearanceDialog client={fake.client} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('radio', { name: '已购骑士' }));
    fireEvent.click(screen.getByRole('radio', { name: '上装默认款' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(fake.request).toHaveBeenCalledWith('/appearance', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ character_key: 'owned-knight', upper_wearable_key: 'upper-default' }) }));
    fireEvent.click(screen.getByRole('radio', { name: '上装新款' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    const writes = fake.request.mock.calls.filter(([, options]) => options?.method === 'PUT');
    const secondWrite = writes[1]![1]!;
    expect(secondWrite.body).toMatchObject({ upper_wearable_key: 'upper-owned' });
  });

  it('可用的空穿戴排在默认衣服前，显示通用图标并保留免费选择身份', async () => {
    const state = characterCatalogFixture();
    const upper = state.wearables.find((item) => item.wearable_key === 'upper-default')!;
    state.wearables.push({ ...upper, wearable_key: 'upper-none', name: '不穿上装', nodes: [], covers: [], empty: true });
    state.characters[1]!.defaults = { ...state.characters[1]!.defaults, upper: 'upper-none' };
    const fake = appearanceClient(async (_path, options) => options.method === 'PUT' ? { ...state, ...options.body as object, version: 2 } : state);
    render(<AppearanceDialog client={fake.client} onClose={vi.fn()} onSaved={vi.fn()} />);

    const empty = await screen.findByRole('radio', { name: '不穿上装' });
    const group = within(screen.getByRole('group', { name: '上装' }));
    expect(group.getAllByRole('radio')[0]).toBe(empty);
    expect(empty.closest('label')?.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    expect(empty.closest('label')?.querySelector('img')).toBeNull();
    expect(group.getByRole('radio', { name: '上装默认款' })).toBeChecked();

    fireEvent.click(empty);
    expect(empty).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    await screen.findByText('外观已保存。');
    expect(fake.request).toHaveBeenCalledWith('/appearance', expect.objectContaining({
      method: 'PUT', body: expect.objectContaining({ upper_wearable_key: 'upper-none' }),
    }));
  });

  it('免费衣服选择遇到版本冲突仍保留，核对后按新版本保存同一件衣服', async () => {
    const state = characterCatalogFixture();
    state.character_key = 'owned-knight';
    state.characters[1]!.defaults = { face: 'face-default', back: 'back-default', head: 'head-owned', upper: 'upper-owned', lower: 'lower-owned', shoes: 'shoes-owned' };
    let writes = 0, reads = 0;
    const fake = appearanceClient(async (_path, options) => {
      if (options.method === 'PUT') {
        if (++writes === 1) throw new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' });
        return { ...state, ...options.body as object, version: 3 };
      }
      return { ...state, version: ++reads === 1 ? 1 : 2 };
    });
    render(<AppearanceDialog client={fake.client} onClose={vi.fn()} onSaved={vi.fn()} />);
    const freeOption = await screen.findByRole('radio', { name: '上装默认款' });
    fireEvent.click(freeOption);
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    fireEvent.click(await screen.findByRole('button', { name: '读取当前外观' }));
    fireEvent.click(await screen.findByRole('button', { name: '保留草稿继续编辑' }));
    expect(freeOption).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    await screen.findByText('外观已保存。');
    expect(fake.request.mock.calls.filter(([, options]) => options?.method === 'PUT').at(-1)![1]!.body).toMatchObject({ expected_version: 2, upper_wearable_key: 'upper-default' });
  });
});
