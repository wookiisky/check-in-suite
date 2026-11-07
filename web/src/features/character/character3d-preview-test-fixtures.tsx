import { Children, isValidElement } from 'react';
import type { ReactNode } from 'react';

// JSDOM 尚未提供 PointerEvent；保留真实鼠标坐标并补充指针身份。
export class CharacterTestPointerEvent extends MouseEvent {
  readonly pointerId: number; // 同一次拖动的指针身份。
  readonly isPrimary: boolean; // 触屏第一根手指。
  readonly pointerType: string; // 测试使用的输入类型。

  constructor(type: string, options: PointerEventInit = {}) {
    super(type, options);
    this.pointerId = options.pointerId ?? 1;
    this.isPrimary = options.isPrimary ?? true;
    this.pointerType = options.pointerType ?? 'mouse';
  }
}

// 捕获只模拟浏览器的指针归属；实际拖出区域的行为由端到端测试验证。
export function prepareCharacterPointerCapture(element: HTMLElement) {
  const pointers = new Set<number>();
  element.setPointerCapture = (id) => { pointers.add(id); };
  element.hasPointerCapture = (id) => pointers.has(id);
  element.releasePointerCapture = (id) => { pointers.delete(id); };
}

// DOM 测试仅挂载模型业务组件；灯光和取景由真实浏览器验证。
export function CharacterTestCanvas({ children }: { children: ReactNode }) {
  return <div data-testid="character-test-canvas">{Children.toArray(children).filter((child) => isValidElement(child) && typeof child.props === 'object' && child.props !== null && 'snapshot' in child.props)}</div>;
}

// JSDOM 没有媒体查询；这个静态实现只为普通预览 DOM 测试提供浏览器接口。
export function characterTestMatchMedia(): MediaQueryList {
  return { matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
}
