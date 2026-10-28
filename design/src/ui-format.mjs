import { copy as c } from '../config/content.mjs';
import { icon } from './icons.mjs';

// 动态内容在进入模板前统一转义。
export function esc(value = '') {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// 模板文案集中配置，替换值仍按文本处理。
export function t(key, values = {}) {
  return String(c[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => esc(values[name] ?? ''));
}

// 纯日期使用固定 UTC 中午格式化，不受设备时区影响。
export function dateLabel(date, full = false) {
  const fields = full ? { month: 'long', day: 'numeric', weekday: 'long' } : { month: 'numeric', day: 'numeric' };
  return new Intl.DateTimeFormat('zh-CN', { ...fields, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

// 月标题与记录日期采用相同的纯日期语义。
export function monthLabel(month) {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));
}

// 星期文字由本地化日期接口提供。
export function weekdayLabel(date) {
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

// 两种货币同时展示，图像之外保留读屏可辨识的币种名称。
export function rewards(coins, gems, plus = false) {
  return `<span class="reward-inline"><span class="currency coin">${icon('coin')}<span class="sr-only">${c.coins}</span><span>${plus ? '+' : ''}${coins}</span></span><span class="currency gem">${icon('gem')}<span class="sr-only">${c.gems}</span><span>${plus ? '+' : ''}${gems}</span></span></span>`;
}
