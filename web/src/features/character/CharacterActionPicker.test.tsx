import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CharacterActionPicker } from './CharacterActionPicker';
import { previewActionKey, resolveCharacterPreviewAction } from './character-preview-actions';
import { appearanceFixture } from './character3d-test-fixtures';

describe('人物动作检查', () => {
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
