import { expect, test } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';
import { feedbackAudioState, observeFeedbackAudio } from './feedback-audio-observer';

// 用真实奖励回执验证粒子比例、上限、图片加载和手机排版。
test('奖励数量与钻石高亮在浏览器中正确展示', async ({ page }, testInfo) => {
  await observeFeedbackAudio(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await expect(page.getByRole('heading', { name: checkin.todayTasks, exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  const headers = { Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token };
  expect((await page.request.patch('/api/v1/account/preferences', { headers, data: { music_enabled: false, effects_enabled: true, reduce_motion: false } })).ok()).toBeTruthy();
  expect((await page.request.post('/api/v1/management/unlock', { headers, data: { password: 'Manage-Test-2026' } })).ok()).toBeTruthy();
  for (const amount of [2, 20, 50, 1000000]) {
    expect((await page.request.post('/api/v1/management/tasks', {
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      data: { category_id: null, name: `奖励数量-${amount}-${testInfo.project.name}`, icon_key: 'book-v1', coin_reward: amount, diamond_reward: amount, daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true },
    })).ok()).toBeTruthy();
  }
  expect((await page.request.post('/api/v1/management/lock', { headers })).ok()).toBeTruthy();
  await page.reload();
  for (const amount of [2, 20, 50, 1000000]) {
    const task = page.locator('.checkin-task').filter({ hasText: `奖励数量-${amount}-${testInfo.project.name}` });
    const previousNotes = (await feedbackAudioState(page)).notes;
    await expect(task).toBeEnabled();
    await task.click();
    await page.getByRole('dialog').getByRole('button', { name: checkin.checkin, exact: true }).click();
    const notice = page.locator('.checkin-notice');
    await expect(notice.getByText(`${checkin.coins} +${amount}`, { exact: true })).toBeVisible();
    await expect(notice.getByText(`${checkin.diamonds} +${amount}`, { exact: true })).toBeVisible();
    const beats = Math.min(amount, 8);
    await expect.poll(async () => (await feedbackAudioState(page)).notes).toBe(previousNotes + beats * 3 + 2);
    const notes = await page.evaluate((offset) => window.feedbackAudio.scheduled.slice(offset), previousNotes);
    expect(notes.filter((note) => note.waveform === 'triangle')).toHaveLength(beats);
    expect(notes.filter((note) => note.waveform === 'sine')).toHaveLength(beats * 2 + 2);
    expect(Math.max(...notes.map((note) => note.stop!)) - Math.min(...notes.map((note) => note.start))).toBeLessThanOrEqual(1.6);
    await expect(notice.locator('.checkin-reward-coins .checkin-reward-particle')).toHaveCount(Math.min(amount, 50));
    await expect(notice.locator('.checkin-reward-diamonds .checkin-reward-particle')).toHaveCount(Math.min(amount, 50));
    await expect(notice.locator('.checkin-reward-featured .checkin-reward-icon')).toHaveCSS('width', '52px');
    await expect(notice.locator('.checkin-reward-coins .checkin-reward-icon')).toHaveCSS('width', '32px');
    expect(await notice.locator('.checkin-reward-icon').evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBeTruthy();
    // 在同一动画进度取图，人工检查少量和大量奖励的可见差别。
    await notice.evaluate((element) => {
      for (const animation of element.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = 550; }
    });
    await notice.screenshot({ path: testInfo.outputPath(`reward-${amount}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await expect(notice.locator('.checkin-reward-particle')).toHaveCount(0);
    await expect(notice.getByText(`${checkin.diamonds} +${amount}`, { exact: true })).toBeVisible();
  }
});
