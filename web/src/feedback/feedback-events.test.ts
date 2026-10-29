import { describe, expect, it, vi } from 'vitest';
import { dispatchFeedback, FEEDBACK_EVENT } from './feedback-events';

describe('业务成功反馈事件', () => {
  it('将确认成功的操作类型发送给共享声音实例', () => {
    const received = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, received);
    dispatchFeedback('purchase');
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0]![0]).toMatchObject({ detail: 'purchase' });
    window.removeEventListener(FEEDBACK_EVENT, received);
  });
});
