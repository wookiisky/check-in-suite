import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IslandApp } from './IslandApp';
import content from './content/zh-CN.json';

describe('开发环境连接状态', () => {
  it('请求完成前展示加载状态，成功后展示就绪状态', async () => {
    let finishRequest!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () => new Promise((resolve) => { finishRequest = resolve; }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<IslandApp />);
    expect(screen.getByRole('status')).toHaveTextContent(content.connection.loading);
    expect(fetchMock).toHaveBeenCalledWith('/health/ready', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));

    await act(async () => finishRequest(Response.json({ status: 'ok' })));
    expect(screen.getByRole('status')).toHaveTextContent(content.connection.ready);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each([
    ['网络失败', () => Promise.reject(new TypeError('Network error'))],
    ['服务不可用', () => Promise.resolve(Response.json({ status: 'unavailable' }, { status: 503 }))],
    ['响应格式错误', () => Promise.resolve(Response.json({ status: 'unexpected' }))],
  ])('%s 后保留可重试入口', async (_reason, failedRequest) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(failedRequest)
      .mockResolvedValueOnce(Response.json({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<IslandApp />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(content.connection.error));
    fireEvent.click(screen.getByRole('button', { name: content.retry }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(content.connection.ready));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('页面卸载时取消未完成请求', () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<IslandApp />);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;

    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
