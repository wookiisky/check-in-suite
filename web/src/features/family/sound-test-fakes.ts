import { vi } from 'vitest';

// 增益节点的自动化参数与连接记录。
type FakeGain = {
  gain: Record<'setValueAtTime' | 'linearRampToValueAtTime' | 'exponentialRampToValueAtTime', ReturnType<typeof vi.fn>>; // 音量包络。
  connect: ReturnType<typeof vi.fn>; // 输出连接。
  disconnect: ReturnType<typeof vi.fn>; // 输出释放。
};

// 保留音符调度和连接记录，测试真实引擎对 Web Audio 的调用。
export class FakeOscillator {
  frequency = { value: 0 }; // 音符频率。
  type: OscillatorType = 'sine'; // 合成波形。
  onended: (() => void) | null = null; // 浏览器结束音符时的资源释放回调。
  connect = vi.fn(); // 输出连接记录。
  disconnect = vi.fn(); // 输出释放记录。
  start = vi.fn(); // 开始时间记录。
  stop = vi.fn(); // 结束时间记录。
}

// 无真实扬声器的 AudioContext，仅供音符及生命周期测试。
export class FakeAudioContext {
  static instances: FakeAudioContext[] = []; // 测试创建的上下文。
  state: AudioContextState = 'suspended'; // 当前播放状态。
  currentTime = 10; // 固定的音频时钟。
  destination = {}; // 虚拟扬声器。
  oscillators: FakeOscillator[] = []; // 所有创建的音符。
  gains: FakeGain[] = []; // 所有增益节点。
  resume = vi.fn(async () => { this.state = 'running'; }); // 模拟用户手势后的激活。
  close = vi.fn(async () => { this.state = 'closed'; }); // 模拟释放浏览器音频资源。

  // 记录实例，供测试检查何时创建音频上下文。
  constructor() { FakeAudioContext.instances.push(this); }

  // 创建可检查的虚拟音符。
  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  // 记录包络线和节点释放，验证短音不会长期保持音量。
  createGain(): FakeGain {
    const gain = { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
    this.gains.push(gain);
    return gain;
  }
}
