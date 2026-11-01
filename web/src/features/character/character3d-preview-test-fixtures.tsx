import { Children, isValidElement } from 'react';
import type { ReactNode } from 'react';

// DOM 测试仅挂载模型业务组件；灯光和取景由真实浏览器验证。
export function CharacterTestCanvas({ children }: { children: ReactNode }) {
  return <div data-testid="character-test-canvas">{Children.toArray(children).filter((child) => isValidElement(child) && typeof child.props === 'object' && child.props !== null && 'snapshot' in child.props)}</div>;
}

// JSDOM 没有媒体查询；这个静态实现只为普通预览 DOM 测试提供浏览器接口。
export function characterTestMatchMedia(): MediaQueryList {
  return { matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
}
