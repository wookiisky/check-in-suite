import { cartoonIcons } from './cartoon-icons.mjs';

/** 基础操作图标保留文字色，适应浅色面板和深色按钮。 */
const paths = {
  mute: '<path d="m11 5-5 4H2v6h4l5 4V5Zm5 4 6 6m0-6-6 6"/>',
  sound: '<path d="m11 5-5 4H2v6h4l5 4V5Zm5 3c3 2 3 6 0 8m3-11c5 4 5 10 0 14"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  edit: '<path d="m14 5 5 5M3 21l6-1L21 8a3.5 3.5 0 0 0-5-5L4 15l-1 6Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  logout: '<path d="M10 3H3v18h7m5-14 5 5-5 5M8 12h12"/>',
};

/** 返回统一尺寸的装饰图标，名称未知时使用星星插画。 */
export function icon(name, extra = '') {
  const drawing = cartoonIcons[name] || (paths[name]
    ? `<g transform="scale(2)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</g>`
    : cartoonIcons.star);
  return `<svg class="icon ${extra}" width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true">${drawing}</svg>`;
}
