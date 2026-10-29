import { expect, test } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import family from '../src/features/family/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';
import { feedbackAudioState, observeFeedbackAudio } from './feedback-audio-observer';

// 真实API确认奖励，浏览器验证动画、系统偏好和音频节点的实际调度。
test('打卡动效、静态反馈和用户手势后的音效', async ({ page }, testInfo) => {
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
  const taskName = `动效反馈-${testInfo.project.name}`;
  expect((await page.request.post('/api/v1/management/tasks', {
    headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
    data: { category_id: null, name: taskName, icon_key: 'book-v1', coin_reward: 7, diamond_reward: 3, daily_limit: 3, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true },
  })).ok()).toBeTruthy();
  expect((await page.request.post('/api/v1/management/lock', { headers })).ok()).toBeTruthy();
  await page.reload();
  const task = page.locator('.checkin-task').filter({ hasText: taskName });
  await expect(task).toBeEnabled();
  expect(await feedbackAudioState(page)).toEqual({ notes: 0, contexts: [] });

  await task.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveCSS('animation-name', 'dialog-appear');
  expect((await feedbackAudioState(page)).notes).toBe(0);
  await dialog.getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(page.getByText(`${checkin.coins} +7`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${checkin.diamonds} +3`, { exact: true })).toBeVisible();
  await expect(page.locator('.checkin-reward-coins .checkin-reward-particle')).toHaveCount(7);
  await expect(page.locator('.checkin-reward-diamonds .checkin-reward-particle')).toHaveCount(3);
  await expect(page.locator('.checkin-reward-diamonds')).toHaveClass(/checkin-reward-featured/);
  await expect(page.getByLabel(checkin.balance).locator('strong.feedback-pop')).toHaveCount(2);
  await expect.poll(async () => (await feedbackAudioState(page)).notes).toBeGreaterThan(0);
  const playedAudio = await feedbackAudioState(page);
  expect(playedAudio.notes).toBe(7 + 3 * 2 + 2);
  expect(playedAudio.contexts).toEqual(['running']);
  const bounds = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);

  await page.getByLabel(family.reduceMotion, { exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-reduce-motion', 'true');
  await task.click();
  await expect(dialog).toHaveCSS('animation-name', 'none');
  const close = dialog.getByRole('button', { name: checkin.close, exact: true });
  await close.hover();
  await expect(close).toHaveCSS('transform', 'none');
  await expect(close).toHaveCSS('translate', 'none');
  await expect(close).toHaveCSS('scale', 'none');
  await close.click();
  await page.getByLabel(family.reduceMotion, { exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-reduce-motion', 'false');
  await expect(page.getByLabel(checkin.balance).locator('strong.feedback-pop')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('body')).toHaveAttribute('data-reduce-motion', 'true');
  await task.click();
  await expect(dialog).toHaveCSS('animation-name', 'none');
  await dialog.getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`${checkin.diamonds} +3`, { exact: true })).toBeVisible();
  await expect(page.locator('.checkin-reward-particle')).toHaveCount(0);
  const notesAfterReducedCheckin = (await feedbackAudioState(page)).notes;
  expect(notesAfterReducedCheckin).toBe(playedAudio.notes * 2);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('body')).toHaveAttribute('data-reduce-motion', 'false');
  await expect(page.getByLabel(checkin.balance).locator('strong.feedback-pop')).toHaveCount(0);

  await page.getByLabel(family.effects, { exact: true }).click();
  await expect(page.getByLabel(family.effects, { exact: true })).not.toBeChecked();
  await task.click();
  await dialog.getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`${checkin.coins} +7`, { exact: true })).toBeVisible();
  expect((await feedbackAudioState(page)).notes).toBe(notesAfterReducedCheckin);

  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  await expect(page.locator('.page-content')).toHaveCSS('animation-name', 'page-appear');
  await page.getByRole('button', { name: content.navigation.camp, exact: true }).click();
  await expect(page.getByRole('heading', { name: checkin.todayTasks, exact: true })).toBeVisible();
  await expect(page.getByText(`${checkin.coins} +7`, { exact: true })).toHaveCount(0);
  expect((await feedbackAudioState(page)).notes).toBe(notesAfterReducedCheckin);
});
