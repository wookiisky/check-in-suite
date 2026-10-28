import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioCapture } from './audio-capture';
import { FakeAudioTrack, FakeMediaRecorder } from './media-test-fakes';
import { isRecordingActive } from './recordingActivity';

let captures: AudioCapture[] = [];
let track: FakeAudioTrack;
const callbacks = () => ({ onState: vi.fn(), onFile: vi.fn(), onError: vi.fn(), onTime: vi.fn() });

beforeEach(() => {
  track = new FakeAudioTrack();
  FakeMediaRecorder.instances = []; FakeMediaRecorder.supported = true;
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) } });
});
afterEach(() => { for (const capture of captures) capture.dispose(); captures = []; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// 将生命周期绑定在每个测试，以免失败测试遗留计时器或采集状态。
function makeCapture() { const events = callbacks(); const capture = new AudioCapture(events, { audio_bytes_max: 1024, audio_seconds_max: 60 }); captures.push(capture); return { capture, events }; }

describe('真实浏览器录音控制边界', () => {
  it('停止后等待最后分片，生成可试听文件并关闭音轨', async () => {
    const { capture, events } = makeCapture();
    await capture.start(); expect(isRecordingActive()).toBe(true);
    capture.stop();
    expect(events.onFile).toHaveBeenCalledOnce();
    expect(events.onFile.mock.calls[0]?.[0]).toBeInstanceOf(File);
    expect(track.stop).toHaveBeenCalled(); expect(isRecordingActive()).toBe(false);
  });
  it('权限拒绝给出可恢复错误并恢复音乐状态', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const { capture, events } = makeCapture(); await capture.start();
    expect(events.onError).toHaveBeenCalledWith('permission'); expect(events.onFile).not.toHaveBeenCalled(); expect(isRecordingActive()).toBe(false);
  });
  it('格式不支持时不调用麦克风', async () => {
    FakeMediaRecorder.supported = false;
    const { capture, events } = makeCapture(); await capture.start();
    expect(events.onError).toHaveBeenCalledWith('unsupported'); expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
  it('关闭后迟到的许可只释放音轨，不开始录制', async () => {
    let permit!: (stream: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(new Promise((resolve) => { permit = resolve; }));
    const { capture, events } = makeCapture(); const started = capture.start(); capture.dispose();
    permit({ getTracks: () => [track] } as unknown as MediaStream); await started;
    expect(track.stop).toHaveBeenCalledOnce(); expect(FakeMediaRecorder.instances).toHaveLength(0); expect(events.onFile).not.toHaveBeenCalled();
  });
  it('计时按单调时钟计算并在期限停止', async () => {
    vi.useFakeTimers(); const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { capture, events } = makeCapture(); await capture.start();
    clock.mockReturnValue(61000); await vi.advanceTimersByTimeAsync(250);
    expect(events.onTime).toHaveBeenLastCalledWith(60); expect(events.onFile).toHaveBeenCalledOnce(); expect(isRecordingActive()).toBe(false);
  });
  it('页面进入后台时停止采集并丢弃未完整录音', async () => {
    const { capture, events } = makeCapture(); await capture.start();
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); hidden.mockRestore();
    expect(events.onError).toHaveBeenCalledWith('interrupted'); expect(events.onFile).not.toHaveBeenCalled(); expect(track.stop).toHaveBeenCalled();
  });
});
