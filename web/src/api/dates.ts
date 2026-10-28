// 服务端日期是台北日历日；UTC仅用作不受设备时区影响的日历运算容器。
function parseDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError('Invalid business date');
  }
  return date;
}

// 日、周导航按日历日偏移，不从设备时钟重新决定今天。
export function shiftDate(value: string, days: number): string {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// 周一为起点，星期日回到前六天的周一。
export function weekStart(value: string): string {
  const date = parseDate(value);
  return shiftDate(value, -((date.getUTCDay() + 6) % 7));
}

// 统计与月历共用月份第一天，保留服务端日期中的年和月。
export function monthStart(value: string): string {
  const date = parseDate(value);
  date.setUTCDate(1);
  return date.toISOString().slice(0, 10);
}

// 月历末日按实际月份计算，自动处理闰年和十二月跨年。
export function monthEnd(value: string): string {
  const date = parseDate(value);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return date.toISOString().slice(0, 10);
}
