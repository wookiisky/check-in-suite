import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CharacterActionPicker } from './CharacterActionPicker';
import { characterPreviewAnimations, previewActionKey, resolveCharacterPreviewAction } from './character-preview-actions';
import { appearanceFixture } from './character3d-test-fixtures';

describe('人物动作检查', () => {
  it('共享目录优先于旧人物目录，只将已选动作加入模型准备且切人物回待机', () => {
    const state = appearanceFixture();
    const legacy = { clip: 'Legacy', asset_key: 'legacy', url: '/legacy.glb' };
    const selected = { clip: 'Shared wave', asset_key: 'shared-wave', url: '/shared-wave.glb' };
    const unselected = { clip: 'Shared jump', asset_key: 'shared-jump', url: '/shared-jump.glb' };
    state.characters[0]!.preview_animations = [legacy];
    state.preview_animations = [selected, unselected];
    expect(characterPreviewAnimations(state)).toBe(state.preview_animations);
    const preview = resolveCharacterPreviewAction(state, previewActionKey('body', 0));
    expect(preview.action).toBe('_preview');
    expect(preview.snapshot.characters[0]!.animations._preview).toBe(selected);
    expect(Object.values(preview.snapshot.characters[0]!.animations)).not.toContain(unselected);
    expect(state.characters[0]!.animations._preview).toBeUndefined();
    state.character_key = 'another-body';
    state.characters.push({ ...state.characters[0]!, character_key: 'another-body' });
    expect(resolveCharacterPreviewAction(state, previewActionKey('body', 0))).toEqual({ snapshot: state, action: 'idle' });
  });

  it('明确的空共享目录不回用旧动作，缺少共享字段的旧响应仍可选择原动作', () => {
    const state = appearanceFixture();
    const legacy = { clip: 'Legacy', asset_key: 'legacy', url: '/legacy.glb' };
    state.characters[0]!.preview_animations = [legacy];
    expect(characterPreviewAnimations(state)).toEqual([legacy]);
    expect(resolveCharacterPreviewAction(state, previewActionKey('body', 0)).action).toBe('_preview');
    state.preview_animations = [];
    expect(characterPreviewAnimations(state)).toEqual([]);
    expect(resolveCharacterPreviewAction(state, previewActionKey('body', 0))).toEqual({ snapshot: state, action: 'idle' });
  });

  it('包含目录登记的原始动作和语义动作，选择保留实际动作身份', () => {
    const onChange = vi.fn();
    const animation = { clip: 'Idle', asset_key: 'model', url: '/model.glb' };
    render(<CharacterActionPicker characterKey="body" animations={{ idle: animation }} previewAnimations={[{ ...animation, clip: 'Swim_Fast' }]} value="idle" onChange={onChange} />);
    expect(screen.getByRole('option', { name: '待机' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '原始动作 · Swim_Fast' })).toHaveValue(previewActionKey('body', 0));
    fireEvent.change(screen.getByLabelText('人物动作'), { target: { value: previewActionKey('body', 0) } });
    expect(onChange).toHaveBeenCalledWith(previewActionKey('body', 0));
  });

  it('只把已选原始动作加入临时快照，无效或其他人物的选择回待机且不修改保存数据', () => {
    const state = appearanceFixture();
    const source = { clip: 'Wave', asset_key: 'wave', url: '/wave.glb' };
    state.characters[0]!.preview_animations = [source];
    const selected = resolveCharacterPreviewAction(state, previewActionKey('body', 0));
    expect(selected.action).toBe('_preview');
    expect(selected.snapshot.characters[0]!.animations._preview).toBe(source);
    expect(state.characters[0]!.animations._preview).toBeUndefined();
    expect(resolveCharacterPreviewAction(state, previewActionKey('another-body', 0))).toEqual({ snapshot: state, action: 'idle' });
    expect(resolveCharacterPreviewAction(state, previewActionKey('body', 99))).toEqual({ snapshot: state, action: 'idle' });
  });
});
