import type { FeedbackKind } from '../../feedback/feedback-events';

/** 短音使用音频时钟调度，停止录音或关闭音效时可一并取消尚未发声的音符。 */
const feedbackMelodies: Record<FeedbackKind | 'checkin', readonly number[]> = {
  checkin: [659.25, 830.61, 987.77],
  purchase: [1046.5, 1318.51],
  equip: [783.99, 1046.5],
  'island-save': [523.25, 783.99],
};

/** 单个音符的音色与播放时刻，默认是立即播放的操作音。 */
interface NoteOptions {
  at?: number; // AudioContext 时钟上的绝对开始时间。
  waveform?: OscillatorType; // 金币使用三角波，铃音使用正弦波。
  effect?: boolean; // 背景音乐不随操作音效开关停止。
}

const rewardBeatLimit = 8; // 大奖励合并节拍，不让图标数直接变成密集噪声。
const rewardSpread = 0.35; // 与奖励图标开始出现的错开窗口一致，单位秒。

// SoundEngine只在明确的用户操作后创建AudioContext，合成声音不依赖外部素材。
export class SoundEngine {
  private context: AudioContext | null = null; // 当前浏览器的用户激活音频上下文。
  private timer: ReturnType<typeof setInterval> | null = null; // 短循环旋律的调度器。
  private notes = new Set<OscillatorNode>(); // 暂停录音时立即停止仍在发声的音符。
  private effects = new Set<OscillatorNode>(); // 操作短音单独停止，保留用户正在播放的背景音乐。
  private position = 0; // 当前旋律音符位置。

  // 浏览器不支持或拒绝播放时，调用方保留静态反馈。
  async activate(): Promise<boolean> {
    const constructor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!constructor) return false;
    try {
      this.context ??= new constructor();
      await this.context.resume();
      return this.context.state === 'running';
    } catch { return false; }
  }

  // 音量很低的短旋律由用户开启，所有播放均能显式停止。
  startMusic() {
    if (this.timer || !this.context || this.context.state !== 'running') return;
    const melody = [261.63, 329.63, 392, 329.63, 293.66, 349.23, 440, 349.23];
    const play = () => { this.note(melody[this.position++ % melody.length]!, 0.34, 0.025, { effect: false }); };
    play(); this.timer = setInterval(play, 650);
  }

  // 停止定时器和当前音符，保证采集麦克风前没有背景声音。
  stopMusic() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const note of this.notes) { try { note.stop(); } catch { /* 已停止的节点无需再次处理。 */ } }
    this.notes.clear();
    this.effects.clear();
  }

  // 关闭音效只停止业务短音，不中断用户开启的背景音乐。
  stopEffects() {
    for (const note of this.effects) {
      try { note.stop(); } catch { /* 已结束的节点等待浏览器释放即可。 */ }
      this.notes.delete(note);
    }
    this.effects.clear();
  }

  // 两种奖励在同一音频时钟上开始；数量改变密度，每种最多八拍。
  success(coins: number, diamonds: number) {
    if (coins === 0 && diamonds === 0) { this.playFeedback('checkin'); return; }
    this.stopEffects();
    if (!this.context || this.context.state !== 'running') return;
    const now = this.context.currentTime;
    const coinBeats = Math.min(coins, rewardBeatLimit);
    const diamondBeats = Math.min(diamonds, rewardBeatLimit);
    for (let index = 0; index < coinBeats; index++) {
      const at = now + (coinBeats === 1 ? 0 : index / (coinBeats - 1) * rewardSpread);
      this.note(index % 2 === 0 ? 1046.5 : 1318.51, 0.09, 0.035 / Math.sqrt(coinBeats), { at, waveform: 'triangle' });
    }
    for (let index = 0; index < diamondBeats; index++) {
      const at = now + (diamondBeats === 1 ? 0 : index / (diamondBeats - 1) * rewardSpread);
      const frequency = index % 2 === 0 ? 1567.98 : 2093;
      // 同拍叠加较轻的非整数倍泛音，产生铃声；密集时降低单音增益。
      this.note(frequency, 0.32, 0.026 / Math.sqrt(diamondBeats), { at });
      this.note(frequency * 2.76, 0.22, 0.008 / Math.sqrt(diamondBeats), { at });
    }
    if (diamondBeats > 0) {
      this.note(2093, 0.36, 0.018, { at: now + 0.65 });
      this.note(2637.02, 0.42, 0.022, { at: now + 0.82 });
    }
  }

  // 每次成功使用一组短音，后一次反馈替换未结束的前一次，避免连续操作叠音。
  playFeedback(kind: FeedbackKind | 'checkin') {
    this.stopEffects();
    if (!this.context || this.context.state !== 'running') return;
    const now = this.context.currentTime;
    feedbackMelodies[kind].forEach((frequency, index) => this.note(frequency, 0.18, 0.035, { at: now + index * 0.09 }));
  }

  // 每个音符独立连接并在结束后释放，避免长时间使用积累节点。
  private note(frequency: number, duration: number, volume: number, options: NoteOptions = {}) {
    if (!this.context || this.context.state !== 'running') return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const now = options.at ?? this.context.currentTime;
    oscillator.type = options.waveform ?? 'sine'; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(volume, now + 0.02); gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    oscillator.connect(gain); gain.connect(this.context.destination); this.notes.add(oscillator);
    if (options.effect !== false) this.effects.add(oscillator);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.notes.delete(oscillator); this.effects.delete(oscillator); };
    oscillator.start(now); oscillator.stop(now + duration);
  }

  // 组件卸载关闭上下文，不让音乐留在已经离开的页面。
  dispose() { this.stopMusic(); void this.context?.close().catch(() => {}); this.context = null; }
}
