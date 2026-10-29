import { act } from '@testing-library/react';
import { vi } from 'vitest';

// 手动推进浏览器帧时间，使页面测试不依赖真实等待或定时器调度。
export class IslandAnimationTestClock {
  readonly callbacks = new Map<number, FrameRequestCallback>(); // 当前等待绘制的回调。
  private nextID = 0; // 模拟浏览器返回的帧请求标识。
  private visibility: DocumentVisibilityState = 'visible'; // 模拟当前标签页可见状态。

  // 只替换浏览器时钟，角色推进与页面渲染仍使用真实实现。
  constructor() {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = ++this.nextID;
      this.callbacks.set(id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { this.callbacks.delete(id); });
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => this.visibility);
  }

  // 本帧新请求的回调必须留到下一帧执行。
  frame(timestamp: number) {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    act(() => { callbacks.forEach((callback) => callback(timestamp)); });
  }

  // 与浏览器一致，通过可见性事件通知暂停或恢复。
  setVisibility(visibility: DocumentVisibilityState) {
    this.visibility = visibility;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  }
}
