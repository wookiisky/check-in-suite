import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackKind } from '../../feedback/feedback-events';
import { SoundEngine } from './sound';
import { FakeAudioContext } from './sound-test-fakes';

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
});
afterEach(() => { vi.useRealTimers(); });

describe('合成反馈音', () => {
  it('未由用户激活前不创建音频上下文，也不播放反馈', () => {
    const engine = new SoundEngine();
    engine.success(2, 1);
    engine.playFeedback('purchase');
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('浏览器拒绝激活时返回失败，保持静默且允许再次激活', async () => {
    const engine = new SoundEngine();
    const first = engine.activate();
    await first;
    const context = FakeAudioContext.instances[0]!;
    context.state = 'suspended';
    context.resume.mockRejectedValueOnce(new Error('blocked'));
    expect(await engine.activate()).toBe(false);
    engine.playFeedback('equip');
    expect(context.oscillators).toHaveLength(0);
    expect(await engine.activate()).toBe(true);
    engine.playFeedback('equip');
    expect(context.oscillators.length).toBeGreaterThan(0);
    engine.dispose();
  });

  it('打卡、购买、换装和保存使用不同的短音，所有节点结束后断开', async () => {
    const engine = new SoundEngine();
    await engine.activate();
    const context = FakeAudioContext.instances[0]!;
    const melodies: number[][] = [];
    for (const kind of ['checkin', 'purchase', 'equip', 'island-save'] as const) {
      const previous = context.oscillators.length;
      if (kind === 'checkin') engine.success(0, 0);
      else engine.playFeedback(kind satisfies FeedbackKind);
      const notes = context.oscillators.slice(previous);
      expect(notes.length).toBeGreaterThanOrEqual(2);
      melodies.push(notes.map((note) => note.frequency.value));
      for (const note of notes) {
        const start = note.start.mock.calls[0]![0] as number;
        const stop = note.stop.mock.calls[0]![0] as number;
        expect(stop - start).toBeLessThan(0.4);
        note.onended?.();
        expect(note.disconnect).toHaveBeenCalledTimes(1);
      }
    }
    expect(new Set(melodies.map((notes) => notes.join(','))).size).toBe(4);
    expect(context.gains.every((gain) => gain.disconnect.mock.calls.length === 1)).toBe(true);
    engine.dispose();
  });

  it('关闭音效停止已排队的短音，但背景音乐继续播放', async () => {
    vi.useFakeTimers();
    const engine = new SoundEngine();
    await engine.activate();
    const context = FakeAudioContext.instances[0]!;
    engine.startMusic();
    const music = context.oscillators[0]!;
    engine.playFeedback('purchase');
    const effects = context.oscillators.slice(1);
    engine.stopEffects();
    expect(music.stop).toHaveBeenCalledTimes(1);
    expect(effects.every((note) => note.stop.mock.calls.some((args) => args.length === 0))).toBe(true);
    vi.advanceTimersByTime(650);
    expect(context.oscillators.length).toBeGreaterThan(1 + effects.length);
    engine.dispose();
  });

  it('录音或后台暂停会停止音乐及尚未结束的全部短音', async () => {
    vi.useFakeTimers();
    const engine = new SoundEngine();
    await engine.activate();
    const context = FakeAudioContext.instances[0]!;
    engine.startMusic();
    engine.playFeedback('island-save');
    engine.stopMusic();
    expect(context.oscillators.every((note) => note.stop.mock.calls.some((args) => args.length === 0))).toBe(true);
    const count = context.oscillators.length;
    vi.advanceTimersByTime(2000);
    expect(context.oscillators).toHaveLength(count);
    engine.dispose();
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});

describe('按奖励数量播放收集音', () => {
  it.each([1, 2, 7, 8, 9, 50, 1000000])('金币 %i 对应最多八个清脆节拍，均在动效内结束', async (amount) => {
    const engine = new SoundEngine();
    await engine.activate();
    engine.success(amount, 0);
    const context = FakeAudioContext.instances[0]!;
    expect(context.oscillators).toHaveLength(Math.min(amount, 8));
    expect(context.oscillators.every((note) => note.type === 'triangle')).toBe(true);
    const starts = context.oscillators.map((note) => note.start.mock.calls[0]![0] as number);
    expect(new Set(starts).size).toBe(starts.length);
    expect(starts[0]).toBe(context.currentTime);
    expect(Math.max(...context.oscillators.map((note) => note.stop.mock.calls[0]![0] as number)) - context.currentTime).toBeLessThanOrEqual(1.6);
    engine.dispose();
  });

  it.each([1, 3, 8, 50, 1000000])('钻石 %i 使用双音铃声、余韵和上行尾音', async (amount) => {
    const engine = new SoundEngine();
    await engine.activate();
    engine.success(0, amount);
    const context = FakeAudioContext.instances[0]!;
    const beats = Math.min(amount, 8);
    expect(context.oscillators).toHaveLength(beats * 2 + 2);
    expect(context.oscillators.every((note) => note.type === 'sine')).toBe(true);
    const starts = context.oscillators.map((note) => note.start.mock.calls[0]![0] as number);
    expect(new Set(starts.slice(0, beats * 2)).size).toBe(beats);
    const tail = context.oscillators.slice(-2);
    expect(tail[1]!.frequency.value).toBeGreaterThan(tail[0]!.frequency.value);
    expect(starts.at(-1)).toBeGreaterThan(starts.at(-3)!);
    expect(Math.max(...context.oscillators.map((note) => note.stop.mock.calls[0]![0] as number)) - context.currentTime).toBeLessThanOrEqual(1.6);
    engine.dispose();
  });

  it('两种货币独立计数，金币不会吞掉钻石短音', async () => {
    const engine = new SoundEngine();
    await engine.activate();
    engine.success(2, 3);
    const notes = FakeAudioContext.instances[0]!.oscillators;
    expect(notes.filter((note) => note.type === 'triangle')).toHaveLength(2);
    expect(notes.filter((note) => note.type === 'sine')).toHaveLength(8);
    expect(notes.every((note) => note.stop.mock.calls.length === 1)).toBe(true);
    engine.dispose();
  });

  it('两种奖励都为零时保留简短成功提示', async () => {
    const engine = new SoundEngine();
    await engine.activate();
    engine.success(0, 0);
    const notes = FakeAudioContext.instances[0]!.oscillators;
    expect(notes).toHaveLength(3);
    expect(notes[2]!.frequency.value).toBeGreaterThan(notes[0]!.frequency.value);
    engine.dispose();
  });

  it('奖励增加时降低单音增益，防止密集叠音放大音量', async () => {
    const engine = new SoundEngine();
    await engine.activate();
    const context = FakeAudioContext.instances[0]!;
    engine.success(1, 1);
    const quietCoin = context.gains[0]!.gain.linearRampToValueAtTime.mock.calls[0]![0] as number;
    const quietDiamond = context.gains[1]!.gain.linearRampToValueAtTime.mock.calls[0]![0] as number;
    const previous = context.gains.length;
    engine.success(50, 50);
    const denseCoin = context.gains[previous]!.gain.linearRampToValueAtTime.mock.calls[0]![0] as number;
    const denseDiamond = context.gains[previous + 8]!.gain.linearRampToValueAtTime.mock.calls[0]![0] as number;
    expect(denseCoin).toBeLessThan(quietCoin);
    expect(denseDiamond).toBeLessThan(quietDiamond);
    engine.dispose();
  });

  it('后一次成功替换前一次排队音符，静音时清理本次所有收集音', async () => {
    const engine = new SoundEngine();
    await engine.activate();
    const context = FakeAudioContext.instances[0]!;
    engine.success(50, 50);
    const first = [...context.oscillators];
    engine.success(1, 0);
    expect(first.every((note) => note.stop.mock.calls.some((args) => args.length === 0))).toBe(true);
    const second = context.oscillators.at(-1)!;
    expect(second.stop).toHaveBeenCalledTimes(1);
    engine.stopEffects();
    expect(second.stop).toHaveBeenCalledWith();
    engine.dispose();
  });
});
