import { setRecordingActive } from './recordingActivity';

export type CaptureState = 'idle' | 'requesting' | 'recording' | 'stopping' | 'error';
export type CaptureError = 'unavailable' | 'permission' | 'unsupported' | 'interrupted' | 'failed' | 'tooLarge';
const audioFormats = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];

// 回调只报告录音事实，界面文案由组件资源映射。
interface CaptureEvents {
  onState: (state: CaptureState) => void; // 控制按钮可用性。
  onFile: (file: File) => void; // 最后分片到达后提供完整文件。
  onError: (error: CaptureError) => void; // 可恢复错误标识。
  onTime: (seconds: number) => void; // 单调时钟计算的经过秒数。
}

// 单个弹窗拥有录制器，所有退出路径停止音轨并撤销迟到的许可结果。
export class AudioCapture {
  private recorder: MediaRecorder | null = null; // 当前录制器。
  private stream: MediaStream | null = null; // 当前获准的麦克风流。
  private generation = 0; // 使关闭后的异步权限结果失效。
  private disposed = false; // 防止卸载后的回调改变界面。
  private state: CaptureState = 'idle'; // 当前采集状态。
  private interval: number | null = null; // 仅更新经过时间，不累计计时器次数。
  private deadline: number | null = null; // 最长录音时间的停止通知。
  private startedAt = 0; // performance.now() 时间基准。
  private readonly events: CaptureEvents; // 当前组件的状态回调。
  private readonly limits: { audio_bytes_max: number; audio_seconds_max: number }; // 会话提供的服务端限制。

  constructor(events: CaptureEvents, limits: { audio_bytes_max: number; audio_seconds_max: number }) {
    this.events = events; this.limits = limits;
  }

  // 运行时格式能力和实际创建均须成功，拒绝权限不会改变已有附件。
  async start(): Promise<void> {
    if (this.disposed || ['requesting', 'recording', 'stopping'].includes(this.state)) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { this.fail('unavailable'); return; }
    const supported = audioFormats.filter((type) => MediaRecorder.isTypeSupported(type));
    if (!supported.length) { this.fail('unsupported'); return; }
    const generation = ++this.generation;
    this.updateState('requesting'); setRecordingActive(true);
    document.addEventListener('visibilitychange', this.visibilityChanged);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.disposed || generation !== this.generation) { for (const track of stream.getTracks()) track.stop(); return; }
      this.stream = stream;
      let recorder: MediaRecorder | null = null;
      for (const mimeType of supported) {
        try { recorder = new MediaRecorder(stream, { mimeType }); break; }
        catch { /* 某些浏览器能力探测成功但实际编码器创建失败，继续可用格式。 */ }
      }
      if (!recorder) { this.fail('unsupported'); return; }
      this.recorder = recorder;
      const chunks: Blob[] = [];
      let bytes = 0;
      recorder.ondataavailable = (event) => {
        if (this.recorder !== recorder || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > this.limits.audio_bytes_max) { this.fail('tooLarge'); return; }
        chunks.push(event.data);
      };
      recorder.onerror = () => this.fail('failed');
      recorder.onstop = () => {
        if (this.recorder !== recorder || this.disposed) return;
        if (this.state !== 'stopping') { this.fail('interrupted'); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (!blob.size) { this.fail('failed'); return; }
        const extension = recorder.mimeType.includes('mp4') ? 'm4a' : recorder.mimeType.includes('ogg') ? 'ogg' : 'webm';
        const file = new File([blob], `recording.${extension}`, { type: recorder.mimeType });
        this.release(); this.updateState('idle'); this.events.onFile(file);
      };
      for (const track of stream.getTracks()) track.addEventListener('ended', this.trackEnded);
      recorder.start(1000);
      this.startedAt = performance.now(); this.events.onTime(0); this.updateState('recording');
      this.interval = window.setInterval(this.tick, 200);
      this.deadline = window.setTimeout(() => this.stop(), this.limits.audio_seconds_max * 1000);
    } catch (reason) {
      if (this.disposed || generation !== this.generation) return;
      this.fail(reason instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError'].includes(reason.name) ? 'permission' : 'unavailable');
    }
  }

  // 停止仅请求最后分片；File必须等到随后stop事件才建立。
  stop(): void {
    if (!this.recorder || this.state !== 'recording') return;
    this.updateState('stopping');
    try { this.recorder.stop(); } catch { this.fail('failed'); }
  }

  // 卸载不提交半段录音，迟到的授权会立即释放新取得的音轨。
  dispose(): void {
    this.disposed = true; this.generation++; this.release();
  }

  // 后台中断明确失败，避免节流计时器造成超时长录音继续采集。
  private visibilityChanged = () => { if (document.visibilityState === 'hidden') this.fail('interrupted'); };
  private trackEnded = () => { if (this.state === 'recording') this.fail('interrupted'); };

  // 每次显示都从单调时钟重新计算，长任务不会使计时累积失真。
  private tick = () => {
    if (this.state !== 'recording') return;
    const elapsed = (performance.now() - this.startedAt) / 1000;
    this.events.onTime(Math.min(this.limits.audio_seconds_max, Math.floor(elapsed)));
    if (elapsed >= this.limits.audio_seconds_max) this.stop();
  };

  // 失败保留外部草稿，只结束本次采集。
  private fail(error: CaptureError): void {
    this.generation++; this.release();
    if (!this.disposed) { this.updateState('error'); this.events.onError(error); }
  }

  // 先移除回调再关闭，防止关闭音轨触发递归失败或错误生成文件。
  private release(): void {
    if (this.interval !== null) window.clearInterval(this.interval);
    if (this.deadline !== null) window.clearTimeout(this.deadline);
    this.interval = null; this.deadline = null;
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    const recorder = this.recorder; this.recorder = null;
    if (recorder) { recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null; if (recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* 设备中断可能已经停止录制。 */ } } }
    for (const track of this.stream?.getTracks() ?? []) { track.removeEventListener('ended', this.trackEnded); track.stop(); }
    this.stream = null; setRecordingActive(false);
  }

  // 状态变更只传递给仍存活的界面。
  private updateState(state: CaptureState): void { this.state = state; if (!this.disposed) this.events.onState(state); }
}
