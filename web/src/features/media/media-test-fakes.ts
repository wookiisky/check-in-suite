import { vi } from 'vitest';

// 测试替身只模拟浏览器事件顺序，不作为真实媒体兼容性证据。
export class FakeAudioTrack extends EventTarget {
  stop = vi.fn(); // 验证所有退出路径都停止采集。
}

// 最后一个dataavailable先于stop，符合浏览器MediaRecorder协议。
export class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []; // 当前测试创建的录制器。
  static supported = true; // 测试格式不支持路径。
  static isTypeSupported() { return this.supported; }
  state = 'inactive'; // 当前采集状态。
  mimeType: string; // 实际用于Blob的编码类型。
  ondataavailable: ((event: { data: Blob }) => void) | null = null; // 媒体分片回调。
  onstop: (() => void) | null = null; // 录音停止回调。
  onerror: (() => void) | null = null; // 录音失败回调。
  constructor(_stream: unknown, options: { mimeType: string }) { this.mimeType = options.mimeType; FakeMediaRecorder.instances.push(this); }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['recorded-audio'], { type: this.mimeType }) }); this.onstop?.(); }
}
