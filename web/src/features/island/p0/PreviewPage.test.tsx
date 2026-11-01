import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { PreviewSceneProps } from './PreviewScene';
import { PreviewPage } from './PreviewPage';
import content from './content.json';
import { readFileSync } from 'node:fs';
import type { CharacterSampleDefinition } from '../../character/p0/sample-appearance';

const characterDefinition = JSON.parse(readFileSync('public/models/p0/character/character.json', 'utf8')) as CharacterSampleDefinition;

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

// 等待同源描述加载后再操作场景控件，避免把空白初始帧当成就绪。
async function renderReadyPreview() {
  const rendered = render(<PreviewPage />);
  await waitFor(() => expect(state.scene).not.toBeNull());
  return rendered;
}

describe('P0 样片 HTML 操作', () => {
  beforeEach(() => {
    state.scene = null; state.clear.mockClear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => characterDefinition }));
  });

  it('先读取同源人物描述，读取失败时提供重试', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    render(<PreviewPage />);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(state.scene).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: content.retry }));
    await waitFor(() => expect(state.scene).not.toBeNull());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('暂停和页面隐藏共用场景暂停标志，恢复时不替用户取消暂停', async () => {
    await renderReadyPreview();
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

  it('进出中禁止重复命令，到达后才允许返回门外', async () => {
    await renderReadyPreview();
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

  it('模型或图形失败后保留重试与返回，重试清除失败资源缓存', async () => {
    await renderReadyPreview();
    act(() => state.scene?.onContextLost());
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByRole('link', { name: content.back })).toHaveAttribute('href', '/');
    fireEvent.click(screen.getByRole('button', { name: content.retry }));
    expect(state.clear).toHaveBeenCalledWith(expect.anything(), [characterDefinition.model_url, '/models/p0/animations/exercise.glb']);
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeInTheDocument());
    expect(state.scene?.journey).toBe('outside');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('四槽修改只更新主角色样片草稿', async () => {
    await renderReadyPreview();
    fireEvent.change(screen.getByLabelText(content.slotLabels.hair), { target: { value: 'hair-barbarian' } });
    expect(state.scene?.appearance.hair).toBe('hair-barbarian');
    expect(state.scene?.appearance.upper).toBe('upper-rogue');
  });

  it('切换混搭矩阵时恢复统一取景并停用单角色布置操作', async () => {
    await renderReadyPreview();
    fireEvent.click(screen.getByRole('button', { name: content.showCombinations }));
    expect(state.scene?.showCombinations).toBe(true);
    expect(state.scene?.direction).toBe(0);
    expect(state.scene?.zoom).toBe(1);
    expect(state.scene?.pan).toEqual([0, 0]);
    expect(screen.queryByRole('button', { name: content.enter })).not.toBeInTheDocument();
  });

  it('卸载会取消人物描述请求，迟到结果不能挂载场景', async () => {
    let resolveRead: (response: Response) => void = () => {};
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRead = resolve; }));
    const rendered = render(<PreviewPage />);
    const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
    expect(screen.queryByTestId('canvas')).not.toBeInTheDocument();
    rendered.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => resolveRead(new Response(JSON.stringify(characterDefinition))));
    expect(state.scene).toBeNull();
  });
});
