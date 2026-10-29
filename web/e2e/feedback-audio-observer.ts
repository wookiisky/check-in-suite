import type { Page } from '@playwright/test';

/** 真实浏览器音符的调度记录，停止时间包含后续静音取消。 */
interface ScheduledAudioNote {
  waveform: OscillatorType; // 振荡器波形，用于区分金币与钻石。
  frequency: number; // 振荡器频率。
  start: number; // 音频时钟上的开始时间。
  stop: number | null; // 音频时钟上的结束或取消时间。
}

declare global {
  interface Window {
    feedbackAudio: { notes: number; contexts: AudioContext[]; scheduled: ScheduledAudioNote[] }; // 当前测试页面实际创建的音符与上下文。
  }
}

// 仅观察真实音符启动，不替换AudioContext的调度、节点连接或用户激活行为。
export async function observeFeedbackAudio(page: Page) {
  await page.addInitScript(() => {
    const observed = window as Window & { webkitAudioContext?: typeof AudioContext };
    observed.feedbackAudio = { notes: 0, contexts: [], scheduled: [] };
    const Original = window.AudioContext ?? observed.webkitAudioContext;
    if (!Original) return;
    class ObservedAudioContext extends Original {
      // 浏览器上下文继续处理真实声音，测试只保留状态引用。
      constructor(options?: AudioContextOptions) {
        super(options);
        observed.feedbackAudio.contexts.push(this);
      }

      // 每个start调用仍委托原节点，计数只用于确认业务短音是否触发。
      override createOscillator() {
        const oscillator = super.createOscillator();
        const start = oscillator.start.bind(oscillator);
        const stop = oscillator.stop.bind(oscillator);
        let note: ScheduledAudioNote | undefined;
        oscillator.start = (when?: number) => {
          observed.feedbackAudio.notes += 1;
          note = { waveform: oscillator.type, frequency: oscillator.frequency.value, start: when ?? this.currentTime, stop: null };
          observed.feedbackAudio.scheduled.push(note);
          start(when);
        };
        oscillator.stop = (when?: number) => {
          if (note) note.stop = when ?? this.currentTime;
          stop(when);
        };
        return oscillator;
      }
    }
    window.AudioContext = ObservedAudioContext;
  });
}

// 读取浏览器实际创建的音符数和上下文状态，不能代表扬声器听感。
export async function feedbackAudioState(page: Page) {
  return page.evaluate(() => {
    return { notes: window.feedbackAudio.notes, contexts: window.feedbackAudio.contexts.map((context) => context.state) };
  });
}
