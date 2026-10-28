import { describe, expect, it, vi } from 'vitest';
import { createPendingCheckin, replayCheckin } from './submission';
import { recordFixture, taskFixture } from './test-fixtures';

describe('打卡提交恢复', () => {
  it('响应未知后仍重放原始请求，改变草稿不生成另一条记录', async () => {
    const request = vi.fn().mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce({ checkin: recordFixture, wallet: { coins: 2, diamonds: 1, version: 2 }, task_remaining: 1, today: '2026-10-29' });
    const client = { request };
    const pending = createPendingCheckin(taskFixture, '2026-10-29', '原始文字', false);
    await expect(replayCheckin(client, pending)).rejects.toThrow('lost response');
    pending.draftText = '修改后的文字';
    const result = await replayCheckin(client, pending);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
    expect(request.mock.calls[1]?.[1].body.text).toBe('原始文字');
    expect(result.checkin.id).toBe(recordFixture.id);
    expect(pending.draftText).toBe('修改后的文字');
  });

  it('普通新增固定expected_today，历史补录固定business_date', () => {
    const today = createPendingCheckin(taskFixture, '2026-10-29', '', false);
    const history = createPendingCheckin(taskFixture, '2026-10-20', '', true);
    expect(today.path).toBe('/checkins');
    expect(today.body).toHaveProperty('expected_today', '2026-10-29');
    expect(today.body).not.toHaveProperty('business_date');
    expect(history.path).toBe('/management/checkins');
    expect(history.body).toHaveProperty('business_date', '2026-10-20');
    expect(history.body).not.toHaveProperty('expected_today');
  });
});
