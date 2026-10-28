// SoundEngine只在明确的用户操作后创建AudioContext，合成声音不依赖外部素材。
export class SoundEngine {
  private context: AudioContext | null = null; // 当前浏览器的用户激活音频上下文。
  private timer: ReturnType<typeof setInterval> | null = null; // 短循环旋律的调度器。
  private notes = new Set<OscillatorNode>(); // 暂停录音时立即停止仍在发声的音符。
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
    const play = () => { this.note(melody[this.position++ % melody.length]!, 0.34, 0.025); };
    play(); this.timer = setInterval(play, 650);
  }

  // 停止定时器和当前音符，保证采集麦克风前没有背景声音。
  stopMusic() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const note of this.notes) { try { note.stop(); } catch { /* 已停止的节点无需再次处理。 */ } }
    this.notes.clear();
  }

  // 成功音只使用已由用户激活的上下文，不擅自突破自动播放限制。
  success() { this.note(659.25, 0.16, 0.045); }

  // 每个音符独立连接并在结束后释放，避免长时间使用积累节点。
  private note(frequency: number, duration: number, volume: number) {
    if (!this.context || this.context.state !== 'running') return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const now = this.context.currentTime;
    oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(volume, now + 0.02); gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    oscillator.connect(gain); gain.connect(this.context.destination); this.notes.add(oscillator);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.notes.delete(oscillator); };
    oscillator.start(now); oscillator.stop(now + duration);
  }

  // 组件卸载关闭上下文，不让音乐留在已经离开的页面。
  dispose() { this.stopMusic(); void this.context?.close().catch(() => {}); this.context = null; }
}
