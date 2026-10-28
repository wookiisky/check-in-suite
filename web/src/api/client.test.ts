import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiFailure } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('请求模块', () => {
  it('写入携带CSRF和原幂等键，空响应不会尝试解析JSON', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', request);
    const client = new ApiClient();
    client.setCsrfToken('csrf');
    await expect(client.request<void>('/example', { method: 'POST', body: { x: 1 }, idempotencyKey: 'original-key' })).resolves.toBeUndefined();
    const headers = request.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('X-CSRF-Token')).toBe('csrf');
    expect(headers.get('Idempotency-Key')).toBe('original-key');
  });

  it.each([401, 403])('%s 通知页面清除失效权限并保留结构化错误', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ code: 'SESSION_REQUIRED', field_errors: {}, request_id: 'req' }, { status })));
    const invalidate = vi.fn();
    await expect(new ApiClient(invalidate).request('/example')).rejects.toBeInstanceOf(ApiFailure);
    expect(invalidate).toHaveBeenCalledWith(status);
  });

  it.each([
    ['HISTORY_READ_ONLY', false],
    ['MANAGEMENT_REQUIRED', true],
    ['CSRF_INVALID', true],
  ])('403 %s 保留业务错误并按实际授权含义处理', async (code, clearsAuthorization) => {
    const detail = { code, field_errors: {}, request_id: 'business-request' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(detail, { status: 403 })));
    const invalidate = vi.fn();
    await expect(new ApiClient(invalidate).request('/checkins/record', {
      method: 'PATCH', body: { text: '保留的草稿', expected_version: 1 },
    })).rejects.toMatchObject({ status: 403, detail });
    if (clearsAuthorization) expect(invalidate).toHaveBeenCalledWith(403);
    else expect(invalidate).not.toHaveBeenCalled();
  });

  it('上传表单交给浏览器产生multipart边界，不强行设置JSON类型', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'media' }));
    vi.stubGlobal('fetch', request);
    const form = new FormData(); form.append('file', new Blob(['x']), 'sample.txt');
    await new ApiClient().request('/media', { method: 'POST', body: form });
    expect((request.mock.calls[0]?.[1]?.headers as Headers).has('Content-Type')).toBe(false);
    expect(request.mock.calls[0]?.[1]?.body).toBe(form);
  });
});

it('服务端时间只在真实响应时校准，之后随设备经过的时间推进', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-10-28T15:00:00Z'));
    const client = new ApiClient();
    client.recordServerTime('2026-10-28T15:59:59Z');
    expect(client.now().toISOString()).toBe('2026-10-28T15:59:59.000Z');
    vi.advanceTimersByTime(2000);
    expect(client.now().toISOString()).toBe('2026-10-28T16:00:01.000Z');
  } finally { vi.useRealTimers(); }
});
