import { expect, test } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import reports from '../src/features/reports/content.json' with { type: 'json' };
import family from '../src/features/family/content.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import media from '../src/features/media/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';
import { closeConfigurationSettings, openConfigurationSettings } from './configuration-navigation';

// 只在临时测试服务创建数据，随后通过实际页面完成查询、留言与媒体闭环。
test('真实日月统计、留言恢复、偏好持久与照片附件', async ({ page, context }, testInfo) => {
  if (testInfo.project.name === 'desktop-chromium') await context.grantPermissions(['microphone']);
  const recordAudio = async () => {
    await page.getByRole('dialog').getByRole('button', { name: new RegExp(`${media.startRecording}|${media.recordAgain}`) }).click();
    await expect(page.getByRole('button', { name: media.stopRecording, exact: true })).toBeVisible();
    await page.waitForTimeout(1200); // 真实MediaRecorder需要产生可解码音频样本。
    await page.getByRole('button', { name: media.stopRecording, exact: true }).click();
    await expect(page.getByRole('button', { name: media.useRecording, exact: true })).toBeVisible();
    await expect.poll(async () => page.getByRole('dialog').locator('audio').evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: media.useRecording, exact: true }).click();
  };
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await expect(page.getByRole('heading', { name: family.title })).toBeVisible();
  const session = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  const headers = { Origin: 'http://127.0.0.1:15173', 'X-CSRF-Token': session.csrf_token };
  const unlock = await page.request.post('/api/v1/management/unlock', { headers, data: { password: 'Manage-Test-2026' } });
  expect(unlock.ok()).toBeTruthy();
  const taskName = `照片记录-${testInfo.project.name}`;
  const taskResponse = await page.request.post('/api/v1/management/tasks', { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: { category_id: null, name: taskName, icon_key: 'brush-v1', coin_reward: 2, diamond_reward: 1, daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true } });
  expect(taskResponse.ok()).toBeTruthy();
  const task = await taskResponse.json() as components['schemas']['Task'];
  await page.request.post('/api/v1/management/lock', { headers });
  await page.reload();
  await page.locator('.checkin-task').filter({ hasText: taskName }).click();
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32; const context = canvas.getContext('2d')!; context.fillStyle = '#537244'; context.fillRect(0, 0, 32, 32); return canvas.toDataURL('image/png').split(',')[1]!; });
  await page.getByRole('dialog').getByLabel(media.choosePhoto, { exact: true }).setInputFiles({ name: 'growth.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.getByAltText(media.photoPreview)).toBeVisible();
  if (testInfo.project.name === 'desktop-chromium') await recordAudio();
  await page.getByRole('dialog').getByLabel(checkin.text).fill('带照片的成长记录');
  await page.getByRole('dialog').getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const records = await (await page.request.get(`/api/v1/checkins?start_date=${session.today}&end_date=${session.today}`)).json() as components['schemas']['CheckinList'];
  const record = records.items.find((item) => item.task_id === task.id)!;
  expect(record.photo_media_id).toBeTruthy();
  if (testInfo.project.name === 'desktop-chromium') expect(record.audio_media_id).toBeTruthy();
  const photoURL = `/api/v1/media/${record.photo_media_id}`;
  expect((await page.request.get(photoURL)).ok()).toBeTruthy();

  // 编辑替换实际附件后再移除，旧文件读取应失效，文字与奖励不重复创建。
  await page.locator('.checkin-record').filter({ hasText: taskName }).click();
  if (record.audio_media_id) {
    await expect(page.getByRole('dialog').locator('audio')).toHaveAttribute('src', new RegExp(record.audio_media_id));
    await expect.poll(async () => page.getByRole('dialog').locator('audio').evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(1);
  }
  await page.getByRole('dialog').getByRole('button', { name: checkin.edit, exact: true }).click();
  await page.getByRole('dialog').getByLabel(media.choosePhoto, { exact: true }).setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  if (testInfo.project.name === 'desktop-chromium') await recordAudio();
  await page.getByRole('dialog').getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const replacedRecords = await (await page.request.get(`/api/v1/checkins?start_date=${session.today}&end_date=${session.today}`)).json() as components['schemas']['CheckinList'];
  const replaced = replacedRecords.items.find((item) => item.id === record.id)!;
  expect(replaced.photo_media_id).not.toBe(record.photo_media_id);
  expect((await page.request.get(photoURL)).status()).toBe(404);
  if (record.audio_media_id) { expect(replaced.audio_media_id).not.toBe(record.audio_media_id); expect((await page.request.get(`/api/v1/media/${record.audio_media_id}`)).status()).toBe(404); }

  await openConfigurationSettings(page);
  if (!await page.getByLabel(family.music, { exact: true }).isChecked()) await page.getByLabel(family.music, { exact: true }).click();
  else await page.getByRole('button', { name: family.playMusic, exact: true }).click();
  await expect(page.getByRole('button', { name: family.pauseMusic, exact: true })).toBeVisible();
  await closeConfigurationSettings(page);

  // 列表迟到成功时保留后续输入，并在跨页面返回后仍可继续编辑。
  let finishMessage!: () => void;
  const heldResponse = new Promise<void>((resolve) => { finishMessage = resolve; });
  let messageCommitted!: () => void;
  const committed = new Promise<void>((resolve) => { messageCommitted = resolve; });
  await page.route('**/api/v1/messages', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const response = await route.fetch(); messageCommitted(); await heldResponse; await route.fulfill({ response });
  });
  const message = `家人留言-${testInfo.project.name}`;
  await page.getByLabel(family.input).fill(message);
  await page.getByRole('button', { name: family.publish, exact: true }).click();
  await committed;
  await page.getByLabel(family.input).fill('后续草稿不会被清空');
  finishMessage();
  await expect(page.locator('.family-messages')).toContainText(message);
  await expect(page.getByLabel(family.input)).toHaveValue('后续草稿不会被清空');
  await page.unroute('**/api/v1/messages');
  await openConfigurationSettings(page);
  if (!await page.getByLabel(family.reduceMotion, { exact: true }).isChecked()) await page.getByLabel(family.reduceMotion, { exact: true }).click();
  await expect(page.getByLabel(family.reduceMotion, { exact: true })).toBeChecked();
  await expect(page.locator('body')).toHaveAttribute('data-reduce-motion', 'true');
  await closeConfigurationSettings(page);

  await page.getByRole('button', { name: content.navigation.calendar, exact: true }).click();
  await page.locator('.calendar-day[data-today=true]').click();
  await expect(page.getByRole('dialog').locator('.checkin-record').filter({ hasText: taskName })).toBeVisible();
  await page.getByRole('dialog').locator('.checkin-record').filter({ hasText: taskName }).click();
  await expect(page.getByRole('dialog').locator(`img[src*="${replaced.photo_media_id}"]`)).toBeVisible();
  await expect.poll(async () => page.getByRole('dialog').locator(`img[src*="${replaced.photo_media_id}"]`).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: content.navigation.stats, exact: true }).click();
  await page.getByRole('combobox', { name: reports.range, exact: true }).selectOption('custom');
  await page.getByLabel(reports.start, { exact: true }).fill(session.today);
  await page.getByLabel(reports.end, { exact: true }).fill(session.today);
  await page.getByRole('button', { name: reports.apply, exact: true }).click();
  await expect(page.locator('.reports-bars li').filter({ hasText: taskName })).toContainText('1');
  const stats = await (await page.request.get(`/api/v1/stats?start_date=${session.today}&end_date=${session.today}`)).json() as components['schemas']['StatsResponse'];
  expect(stats.items.find((item) => item.task_id === task.id)?.count).toBe(1);
  await expect(page.locator('body')).toHaveAttribute('data-reduce-motion', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await page.screenshot({ path: `.local/previews/stats-${testInfo.project.name}.png`, fullPage: true });
  await openConfigurationSettings(page);
  await expect(page.getByRole('button', { name: family.pauseMusic, exact: true })).toBeVisible();
  await page.getByRole('button', { name: family.pauseMusic, exact: true }).click();
  await page.getByLabel(family.music, { exact: true }).click();
  await expect(page.getByLabel(family.music, { exact: true })).not.toBeChecked();
  await closeConfigurationSettings(page);
  await page.getByRole('button', { name: content.navigation.camp, exact: true }).click();
  await expect(page.getByLabel(family.input)).toHaveValue('后续草稿不会被清空');
  await page.locator('.family-messages li').filter({ hasText: message }).getByRole('button', { name: family.remove, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: family.confirmRemove, exact: true }).click();
  await expect(page.locator('.family-messages')).not.toContainText(message);
  await page.locator('.checkin-record').filter({ hasText: taskName }).click();
  await page.getByRole('dialog').getByRole('button', { name: checkin.edit, exact: true }).click();
  await page.getByRole('button', { name: media.removePhoto, exact: true }).click();
  if (replaced.audio_media_id) await page.getByRole('button', { name: media.removeAudio, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await page.request.get(`/api/v1/media/${replaced.photo_media_id}`)).status()).toBe(404);
  if (replaced.audio_media_id) expect((await page.request.get(`/api/v1/media/${replaced.audio_media_id}`)).status()).toBe(404);
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-reduce-motion', 'true');
  await openConfigurationSettings(page);
  await expect(page.getByLabel(family.reduceMotion, { exact: true })).toBeChecked();
  await closeConfigurationSettings(page);
  await page.getByRole('button', { name: content.account.logout, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.loginTitle })).toBeVisible();
  expect((await page.request.get(photoURL)).status()).toBe(401);
});
