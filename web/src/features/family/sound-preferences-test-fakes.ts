import { vi } from 'vitest';

/** 共享声音实例的调用记录，避免偏好测试接触真实扬声器。 */
export const sound = { activate: vi.fn(async () => true), start: vi.fn(), stop: vi.fn(), stopEffects: vi.fn(), success: vi.fn(), feedback: vi.fn(), dispose: vi.fn() };

// 偏好组件使用的声音替身，生命周期和业务短音均可单独断言。
export class SoundEngineFake {
  activate = sound.activate; // 用户手势激活。
  startMusic = sound.start; // 背景音乐播放。
  stopMusic = sound.stop; // 全部声音停止。
  stopEffects = sound.stopEffects; // 仅停止操作短音。
  success = sound.success; // 打卡成功。
  playFeedback = sound.feedback; // 其他业务成功。
  dispose = sound.dispose; // 组件卸载资源释放。
}
