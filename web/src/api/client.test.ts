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

  it('上传表单交给浏览器产生multipart边界，不强行设置JSON类型', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'media' }));
    vi.stubGlobal('fetch', request);
    const form = new FormData(); form.append('file', new Blob(['x']), 'sample.txt');
    await new ApiClient().request('/media', { method: 'POST', body: form });
    expect((request.mock.calls[0]?.[1]?.headers as Headers).has('Content-Type')).toBe(false);
    expect(request.mock.calls[0]?.[1]?.body).toBe(form);
  });
});
