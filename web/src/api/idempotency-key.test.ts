import { describe, expect, it, vi } from 'vitest';
import { createIdempotencyKey } from './idempotency-key';

describe('提交幂等键', () => {
  it('优先调用原生 randomUUID 并保留接收对象', () => {
    const nativeCrypto = {
      randomUUID: vi.fn(function (this: unknown) {
        expect(this).toBe(nativeCrypto);
        return 'ec1e7069-f92b-4974-91c2-0b17172f0b58';
      }),
      getRandomValues: vi.fn(),
    };
    vi.stubGlobal('crypto', nativeCrypto);

    expect(createIdempotencyKey()).toBe('ec1e7069-f92b-4974-91c2-0b17172f0b58');
    expect(nativeCrypto.randomUUID).toHaveBeenCalledOnce();
    expect(nativeCrypto.getRandomValues).not.toHaveBeenCalled();
  });

  it.each([
    { byte: 0, expected: '00000000-0000-4000-8000-000000000000' },
    { byte: 255, expected: 'ffffffff-ffff-4fff-bfff-ffffffffffff' },
  ])('没有 randomUUID 时使用随机字节生成 UUID v4：$byte', ({ byte, expected }) => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(byte));
    vi.stubGlobal('crypto', { getRandomValues });

    expect(createIdempotencyKey()).toBe(expected);
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0]?.[0]).toHaveLength(16);
  });

  it('备用实现为每个新命令重新获取随机字节', () => {
    let byte = 0;
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(byte++));
    vi.stubGlobal('crypto', { getRandomValues });

    const first = createIdempotencyKey();
    const second = createIdempotencyKey();
    expect(first).not.toBe(second);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });
});
