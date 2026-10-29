import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { renderRewardAudio, rewardAudioWav } from './reward-audio-renderer';

// 检查真实 PCM 输出，避免仅凭节点数量推断声音存在、削波或结束时间。
test('金币与钻石声音产生有效样本，在动效内结束且不会削波', async ({ page }, testInfo) => {
  await page.goto('/');
  for (const [coins, diamonds] of [[2, 0], [50, 0], [0, 3], [50, 3], [0, 0]]) {
    const { samples, sampleRate } = await renderRewardAudio(page, coins!, diamonds!);
    let peak = 0;
    let energy = 0;
    for (const sample of samples) { peak = Math.max(peak, Math.abs(sample)); energy += sample * sample; }
    expect(peak).toBeGreaterThan(0.005);
    expect(peak).toBeLessThan(0.25);
    expect(Math.sqrt(energy / samples.length)).toBeGreaterThan(0.001);
    expect(samples.slice(Math.floor(sampleRate * 1.4)).every((sample) => Math.abs(sample) < 0.00001)).toBe(true);
    await writeFile(testInfo.outputPath(`coins-${coins}-diamonds-${diamonds}.wav`), rewardAudioWav(samples, sampleRate));
  }
});
