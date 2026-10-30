import { fireEvent } from '@testing-library/react';
import { vi } from 'vitest';

// jsdom没有布局与指针捕获；在组件边界提供固定画布，实际命中区域由浏览器验证。
export function installAccessoryPointerSurface() {
  const captures = new WeakMap<HTMLElement, Set<number>>();
  const methods = ['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture'] as const;
  const descriptors = methods.map((name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value(this: HTMLElement, id: number) { captures.set(this, new Set([id])); } },
    hasPointerCapture: { configurable: true, value(this: HTMLElement, id: number) { return captures.get(this)?.has(id) ?? false; } },
    releasePointerCapture: { configurable: true, value(this: HTMLElement, id: number) { captures.get(this)?.delete(id); } },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, bottom: 300, right: 300, width: 300, height: 300, toJSON: () => ({}),
  });
  return () => {
    methods.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete HTMLElement.prototype[name];
    });
    vi.restoreAllMocks();
  };
}

// 使用原生MouseEvent传递坐标，并附上React指针处理所需的身份字段。
export function dispatchAccessoryPointer(target: HTMLElement, type: string, x: number, y: number, pointerID = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: pointerID }, pointerType: { value: 'mouse' }, isPrimary: { value: true } });
  fireEvent(target, event);
}
