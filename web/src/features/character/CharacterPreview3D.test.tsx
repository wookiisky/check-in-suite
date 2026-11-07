import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { CharacterModel3D } from './CharacterModel3D';
import type { CharacterLoadStatus } from './character3d-appearance';
import { appearanceFixture } from './character3d-test-fixtures';
import { CharacterPreview3D } from './CharacterPreview3D';
import content from './character3d-content.json';
import { CharacterTestPointerEvent, characterTestMatchMedia, prepareCharacterPointerCapture } from './character3d-preview-test-fixtures';

const model = vi.hoisted(() => ({ changed: undefined as ((status: CharacterLoadStatus) => void) | undefined }));
vi.mock('@react-three/fiber', async () => ({ Canvas: (await import('./character3d-preview-test-fixtures')).CharacterTestCanvas }));
vi.mock('./CharacterModel3D', () => ({ CharacterModel3D: ({ onStatus, rotation = 0, paused }: ComponentProps<typeof CharacterModel3D>) => { model.changed = onStatus; return <span data-testid="character-test-model" data-rotation={rotation} data-paused={paused} />; } }));

// 断言送到实际模型边界的朝向，避免只检查外围容器的标记。
function modelRotation() { return Number(screen.getByTestId('character-test-model').dataset.rotation); }

// 提供有宽度的拖动区域，模拟浏览器捕获；真实布局仍由浏览器检查。
function rotationStage() {
  const stage = document.querySelector<HTMLElement>('.character3d-stage')!;
  vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ width: 320 } as DOMRect);
  prepareCharacterPointerCapture(stage);
  return stage;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', characterTestMatchMedia);
  vi.stubGlobal('PointerEvent', CharacterTestPointerEvent);
});

describe('装扮预览水平旋转', () => {
  it('普通预览默认没有旋转控件，也不响应拖动', () => {
    render(<CharacterPreview3D snapshot={appearanceFixture()} />);
    expect(screen.queryByRole('button', { name: '向右旋转' })).not.toBeInTheDocument();
    const stage = rotationStage();
    fireEvent.pointerDown(stage, { clientX: 20, clientY: 50 });
    fireEvent.pointerMove(stage, { clientX: 180, clientY: 50 });
    expect(modelRotation()).toBe(0);
  });

  it('按钮每次旋转45度，连续一周回到初始朝向并可复位', () => {
    render(<CharacterPreview3D snapshot={appearanceFixture()} rotatable paused />);
    const right = screen.getByRole('button', { name: '向右旋转' });
    for (let step = 1; step <= 8; step += 1) {
      fireEvent.click(right);
      expect(Math.cos(modelRotation())).toBeCloseTo(Math.cos(step * Math.PI / 4));
      expect(Math.sin(modelRotation())).toBeCloseTo(Math.sin(step * Math.PI / 4));
    }
    fireEvent.click(screen.getByRole('button', { name: '向左旋转' }));
    expect(modelRotation()).toBeCloseTo(7 * Math.PI / 4);
    fireEvent.click(screen.getByRole('button', { name: '恢复视角' }));
    expect(modelRotation()).toBe(0);
    expect(screen.getByTestId('character-test-model')).toHaveAttribute('data-paused', 'true');
  });

  it.each(['mouse', 'touch'])('%s 横拖可跨边界继续旋转，松手后停止', (pointerType) => {
    render(<CharacterPreview3D snapshot={appearanceFixture()} rotatable />);
    const stage = rotationStage();
    fireEvent.pointerDown(stage, { pointerId: 1, pointerType, clientX: 20, clientY: 50 });
    expect(stage.hasPointerCapture(1)).toBe(true);
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 180, clientY: 50 });
    expect(modelRotation()).toBeCloseTo(Math.PI);
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 340, clientY: 50 });
    expect(Math.cos(modelRotation())).toBeCloseTo(1);
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 500, clientY: 50 });
    expect(modelRotation()).toBeCloseTo(Math.PI);
    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(stage.hasPointerCapture(1)).toBe(false);
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 580, clientY: 50 });
    expect(modelRotation()).toBeCloseTo(Math.PI);
  });

  it.each(['pointerCancel', 'lostPointerCapture'])('%s 终止拖动，后续移动不改变角度', (event) => {
    render(<CharacterPreview3D snapshot={appearanceFixture()} rotatable />);
    const stage = rotationStage();
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 20, clientY: 50 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 100, clientY: 50 });
    const angle = modelRotation();
    if (event === 'pointerCancel') fireEvent.pointerCancel(stage, { pointerId: 1 });
    else fireEvent.lostPointerCapture(stage, { pointerId: 1 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 180, clientY: 50 });
    expect(modelRotation()).toBe(angle);
  });

  it('纵向手势、非主键和第二指不会误转人物', () => {
    render(<CharacterPreview3D snapshot={appearanceFixture()} rotatable />);
    const stage = rotationStage();
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 20, clientY: 50 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 22, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 180, clientY: 100 });
    expect(modelRotation()).toBe(0);
    fireEvent.pointerDown(stage, { pointerId: 1, button: 2, clientX: 20, clientY: 50 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 180, clientY: 50 });
    expect(modelRotation()).toBe(0);
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 20, clientY: 50 });
    fireEvent.pointerDown(stage, { pointerId: 2, isPrimary: false, clientX: 20, clientY: 50 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 180, clientY: 50 });
    expect(modelRotation()).toBe(0);
  });

  it('换装、保存快照与模型重试保留角度，重开预览恢复初始视角', () => {
    const snapshot = appearanceFixture();
    const onStatus = vi.fn();
    const view = render(<CharacterPreview3D snapshot={snapshot} rotatable onStatus={onStatus} />);
    fireEvent.click(screen.getByRole('button', { name: '向右旋转' }));
    expect(onStatus).toHaveBeenCalledTimes(1);
    view.rerender(<CharacterPreview3D snapshot={{ ...snapshot, version: 2, upper_purchase_id: 'upper-purchase' }} rotatable action="walk" onStatus={onStatus} />);
    expect(modelRotation()).toBeCloseTo(Math.PI / 4);
    act(() => model.changed?.({ phase: 'error', error: new Error('network') }));
    fireEvent.click(screen.getByRole('button', { name: content.retry }));
    expect(modelRotation()).toBeCloseTo(Math.PI / 4);
    view.unmount();
    render(<CharacterPreview3D snapshot={snapshot} rotatable />);
    expect(modelRotation()).toBe(0);
  });
});

describe('正式人物预览的 HTML 恢复', () => {
  it('容器公开快照身份和实际模型状态，便于集成验证保存同步', () => {
    vi.stubGlobal('matchMedia', characterTestMatchMedia);
    const snapshot = appearanceFixture();
    const view = render(<CharacterPreview3D snapshot={snapshot} />);
    const preview = screen.getByRole('region', { name: content.label });
    expect(preview).toHaveAttribute('data-appearance-version', String(snapshot.version));
    expect(preview).toHaveAttribute('data-character-key', snapshot.character_key);
    expect(preview).toHaveAttribute('data-character-status', 'loading');
    act(() => model.changed?.({ phase: 'ready' }));
    expect(preview).toHaveAttribute('data-character-status', 'ready');
    view.rerender(<CharacterPreview3D snapshot={{ ...snapshot, version: snapshot.version + 1 }} />);
    expect(preview).toHaveAttribute('data-appearance-version', String(snapshot.version + 1));
    act(() => model.changed?.({ phase: 'error', error: new Error('network') }));
    expect(preview).toHaveAttribute('data-character-status', 'error');
  });

  it('资源失败重试不重建正在显示旧人物的 Canvas', () => {
    vi.stubGlobal('matchMedia', characterTestMatchMedia);
    render(<CharacterPreview3D snapshot={appearanceFixture()} />);
    const canvas = screen.getByTestId('character-test-canvas'); const previous = screen.getByTestId('character-test-model');
    act(() => model.changed?.({ phase: 'error', error: new Error('network') }));
    fireEvent.click(screen.getByRole('button', { name: '重新加载人物' }));
    expect(screen.getByTestId('character-test-canvas')).toBe(canvas);
    expect(screen.getByTestId('character-test-model')).toBe(previous);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
