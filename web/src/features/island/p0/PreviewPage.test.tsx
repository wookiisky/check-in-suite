import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { PreviewSceneProps } from './PreviewScene';
import { PreviewPage } from './PreviewPage';
import content from './content.json';

const state = vi.hoisted(() => ({ scene: null as PreviewSceneProps | null, clear: vi.fn() }));

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, frameloop }: { children: ReactNode; frameloop: string }) => <div data-testid="canvas" data-frameloop={frameloop}>{children}</div>,
  useLoader: Object.assign(vi.fn(), { clear: state.clear }),
}));

vi.mock('./PreviewScene', async () => {
  const { useEffect } = await import('react');
  return {
    PreviewScene: (props: PreviewSceneProps) => {
      state.scene = props;
      useEffect(props.onReady, [props.onReady]);
      return null;
    },
  };
});

describe('P0 样片 HTML 操作', () => {
  beforeEach(() => {
    state.scene = null; state.clear.mockClear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('暂停和页面隐藏共用场景暂停标志，恢复时不替用户取消暂停', () => {
    render(<PreviewPage />);
    expect(state.scene?.paused).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: content.pause }));
    expect(state.scene?.paused).toBe(true);
    expect(screen.getByTestId('canvas')).toHaveAttribute('data-frameloop', 'demand');
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(state.scene?.paused).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: content.resume }));
    expect(state.scene?.paused).toBe(false);
  });

  it('进出中禁止重复命令，到达后才允许返回门外', () => {
    render(<PreviewPage />);
    fireEvent.click(screen.getByRole('button', { name: content.enter }));
    expect(state.scene?.journey).toBe('entering');
    expect(screen.getByRole('button', { name: content.enter })).toBeDisabled();
    act(() => state.scene?.onArrived());
    expect(state.scene?.journey).toBe('inside');
    fireEvent.click(screen.getByRole('button', { name: content.leave }));
    expect(state.scene?.journey).toBe('leaving');
    act(() => state.scene?.onArrived());
    expect(state.scene?.journey).toBe('outside');
  });

  it('模型或图形失败后保留重试与返回，重试清除失败资源缓存', () => {
    render(<PreviewPage />);
    act(() => state.scene?.onContextLost());
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByRole('link', { name: content.back })).toHaveAttribute('href', '/');
    fireEvent.click(screen.getByRole('button', { name: content.retry }));
    expect(state.clear).toHaveBeenCalledTimes(5);
    expect(state.scene?.journey).toBe('outside');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
