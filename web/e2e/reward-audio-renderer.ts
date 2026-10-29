import type { Page } from '@playwright/test';

// 用浏览器真实音频渲染器生成样本，只替换实时输出与用户激活步骤。
export async function renderRewardAudio(page: Page, coins: number, diamonds: number) {
  return page.evaluate(async ({ coins, diamonds }) => {
    const modulePath = '/src/features/family/sound.ts';
    const { SoundEngine } = await import(modulePath);
    const Original = window.AudioContext;
    let context: OfflineAudioContext;
    class RenderAudioContext extends OfflineAudioContext {
      // 固定渲染整个动效窗口，验证声音能在此窗口内自然结束。
      constructor() { super(1, 44100 * 1.6, 44100); context = this; }
      // 离线渲染没有浏览器实时播放许可，保留引擎的实际节点和包络。
      override get state(): AudioContextState { return 'running'; }
      // 离线上下文由 startRendering 驱动，不依赖用户手势。
      override async resume() {}
      // 离线上下文在渲染完成后自动停止。
      async close() {}
    }
    window.AudioContext = RenderAudioContext as unknown as typeof AudioContext;
    const engine = new SoundEngine();
    try {
      await engine.activate();
      engine.success(coins, diamonds);
      const buffer = await context!.startRendering();
      return { samples: Array.from(buffer.getChannelData(0)), sampleRate: buffer.sampleRate };
    } finally { engine.dispose(); window.AudioContext = Original; }
  }, { coins, diamonds });
}

// PCM 样本保存为标准单声道 WAV，便于直接试听实际合成结果。
export function rewardAudioWav(samples: number[], sampleRate: number): Buffer {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + index * 2));
  return wav;
}
