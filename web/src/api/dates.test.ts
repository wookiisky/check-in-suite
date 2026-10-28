import { describe, expect, it, vi } from 'vitest';
import { monthEnd, monthStart, shiftDate, weekStart } from './dates';

describe('服务端业务日期运算', () => {
  it.each([
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2028-02-29', 1, '2028-03-01'],
  ])('跨月跨年与闰年：%s 偏移 %s 天', (date, offset, expected) => {
    expect(shiftDate(date, offset)).toBe(expected);
  });

  it('周一是起点，周日仍属于前一周且可跨年', () => {
    expect(weekStart('2026-10-26')).toBe('2026-10-26');
    expect(weekStart('2026-11-01')).toBe('2026-10-26');
    expect(weekStart('2027-01-01')).toBe('2026-12-28');
  });

  it('月份范围按实际日历计算', () => {
    expect(monthStart('2028-02-29')).toBe('2028-02-01');
    expect(monthEnd('2028-02-10')).toBe('2028-02-29');
    expect(monthEnd('2026-12-31')).toBe('2026-12-31');
  });

  it('站点午夜前后只使用传入服务端日期，不读取设备时钟', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-28T23:59:59-10:00'));
      expect(shiftDate('2026-10-29', 1)).toBe('2026-10-30');
      expect(weekStart('2026-10-29')).toBe('2026-10-26');
      vi.setSystemTime(new Date('2026-10-29T00:00:01+14:00'));
      expect(shiftDate('2026-10-29', 1)).toBe('2026-10-30');
      expect(weekStart('2026-10-29')).toBe('2026-10-26');
    } finally { vi.useRealTimers(); }
  });

  it('实际切换运行时时区仍得到相同业务日期', () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Honolulu';
      expect(new Date('2026-10-29T00:00:00Z').getDate()).toBe(28);
      expect(shiftDate('2026-10-29', 1)).toBe('2026-10-30');
      expect(weekStart('2027-01-01')).toBe('2026-12-28');
      process.env.TZ = 'Pacific/Kiritimati';
      expect(new Date('2026-10-29T00:00:00Z').getDate()).toBe(29);
      expect(shiftDate('2026-10-29', 1)).toBe('2026-10-30');
      expect(weekStart('2027-01-01')).toBe('2026-12-28');
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it.each(['2026-02-30', '2026-1-1', '2026-10-29T00:00:00Z', 'invalid'])('拒绝无效业务日期 %s', (date) => {
    expect(() => shiftDate(date, 1)).toThrow(RangeError);
  });
});
