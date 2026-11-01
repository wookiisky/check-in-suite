import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CharacterLoadStatus } from './character3d-appearance';
import { appearanceFixture } from './character3d-test-fixtures';
import { CharacterPreview3D } from './CharacterPreview3D';
import { characterTestMatchMedia } from './character3d-preview-test-fixtures';

const model = vi.hoisted(() => ({ changed: undefined as ((status: CharacterLoadStatus) => void) | undefined }));
vi.mock('@react-three/fiber', async () => ({ Canvas: (await import('./character3d-preview-test-fixtures')).CharacterTestCanvas }));
vi.mock('./CharacterModel3D', () => ({ CharacterModel3D: ({ onStatus }: { onStatus: (status: CharacterLoadStatus) => void }) => { model.changed = onStatus; return <span data-testid="character-test-model" />; } }));

describe('正式人物预览的 HTML 恢复', () => {
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
