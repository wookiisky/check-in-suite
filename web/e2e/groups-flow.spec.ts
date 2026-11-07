import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import groups from '../src/features/groups/content.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import { openConfigurationSettings, closeConfigurationSettings } from './configuration-navigation';

// 每个辅助账户有自己的Cookie与CSRF，浏览器流程不依赖客户端指定账户归属。
async function loginAccount(request: APIRequestContext, username: string) {
  const response = await request.post('/api/v1/auth/login', { headers: { Origin: 'http://127.0.0.1:15173' }, data: { username, password: 'Island-Test-2026' } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json() as components['schemas']['SessionResponse'];
  return { session, headers: { Origin: 'http://127.0.0.1:15173', 'X-CSRF-Token': session.csrf_token } };
}

// 三个独立账户验证组内只读、组外拒绝和退组后的真实请求结果。
test('同组查看独立任务、打卡附件和统计，退出后拒绝继续读取', async ({ page, browser, request }, testInfo) => {
  const outsiderContext = await browser.newContext({ baseURL: 'http://127.0.0.1:15173' });
  const peer = await loginAccount(request, 'island-group-peer');
  await loginAccount(outsiderContext.request, 'island-group-outsider');
  const available = await (await request.get('/api/v1/groups')).json() as components['schemas']['GroupState'];
  const group = available.groups.find((item) => item.name === '浏览器测试组')!;
  expect(group).toBeTruthy();
  expect((await request.post('/api/v1/groups/join', { headers: peer.headers, data: { group_id: group.id, password: 'Manage-Test-2026' } })).ok()).toBeTruthy();
  try {
    expect((await request.post('/api/v1/management/unlock', { headers: peer.headers, data: { password: 'Manage-Test-2026' } })).ok()).toBeTruthy();
    const taskName = `同组独立任务-${testInfo.project.name}`;
    const taskResponse = await request.post('/api/v1/management/tasks', { headers: { ...peer.headers, 'Idempotency-Key': crypto.randomUUID() }, data: { category_id: null, name: taskName, icon_key: 'book-v1', coin_reward: 2, diamond_reward: 1, daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true, unlock_activities: [] } });
    expect(taskResponse.ok()).toBeTruthy();
    const task = await taskResponse.json() as components['schemas']['Task'];
    await page.goto('/');
    await page.getByLabel(content.account.username).fill('island-group-viewer');
    await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
    await page.getByRole('button', { name: content.account.login, exact: true }).click();
    await expect(page.getByRole('heading', { name: content.navigation.camp, exact: true })).toBeVisible();
    const viewerSession = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
    const viewerHeaders = { Origin: 'http://127.0.0.1:15173', 'X-CSRF-Token': viewerSession.csrf_token };
    expect(viewerSession.account.id).not.toBe(peer.session.account.id);
    const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32; const drawing = canvas.getContext('2d')!; drawing.fillStyle = '#537244'; drawing.fillRect(0, 0, 32, 32); return canvas.toDataURL('image/png').split(',')[1]!; });
    const upload = await request.post('/api/v1/media', { headers: peer.headers, multipart: { kind: 'photo', file: { name: 'group-photo.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } } });
    expect(upload.ok()).toBeTruthy();
    const photo = await upload.json() as components['schemas']['Media'];
    const creation = await request.post('/api/v1/checkins', { headers: { ...peer.headers, 'Idempotency-Key': crypto.randomUUID() }, data: { task_id: task.id, expected_task_version: task.version, expected_today: peer.session.today, text: '与小伙伴分享的成长记录', photo_media_id: photo.id, audio_media_id: null } });
    expect(creation.ok()).toBeTruthy();
    const created = await creation.json() as components['schemas']['CheckinResult'];
    const photoURL = `/api/v1/media/${photo.id}`;
    expect((await outsiderContext.request.get(`/api/v1/stats?start_date=${peer.session.today}&end_date=${peer.session.today}&account_id=${peer.session.account.id}`)).status()).toBe(403);
    expect((await outsiderContext.request.get(photoURL)).ok()).toBe(false);
    expect((await page.request.get(photoURL)).ok()).toBe(false);
    expect(await page.locator('.checkin-task').filter({ hasText: taskName }).count()).toBe(0);

    await openConfigurationSettings(page);
    await page.getByLabel(groups.existingGroups, { exact: true }).selectOption(String(group.id));
    await page.getByLabel(groups.managementPassword, { exact: true }).fill('Wrong-Password-2026');
    await page.getByRole('button', { name: groups.join, exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel(groups.existingGroups, { exact: true })).toHaveValue(String(group.id));
    await page.getByLabel(groups.managementPassword, { exact: true }).fill('Manage-Test-2026');
    await page.getByRole('button', { name: groups.join, exact: true }).click();
    await expect(page.getByRole('button', { name: groups.leave, exact: true })).toBeVisible();
    await expect(page.getByLabel(groups.managementPassword, { exact: true })).toHaveValue('');
    await closeConfigurationSettings(page);
    await page.getByLabel(groups.memberLabel).selectOption(String(peer.session.account.id));
    await expect(page.locator('.group-member-tasks').getByText(taskName)).toBeVisible();
    await expect(page.locator('.group-member-tasks')).toContainText('已完成 1 / 1，剩余 0');
    await expect(page.locator('.family-panel')).toHaveCount(0);
    await page.locator('.checkin-record').filter({ hasText: taskName }).click();
    await expect(page.getByRole('dialog')).toContainText('与小伙伴分享的成长记录');
    await expect(page.getByRole('dialog').getByRole('button', { name: checkin.edit, exact: true })).toHaveCount(0);
    await expect.poll(async () => page.getByRole('dialog').getByRole('img', { name: checkin.attachmentPhoto }).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.keyboard.press('Escape');
    expect((await page.request.patch(`/api/v1/checkins/${created.checkin.id}`, { headers: viewerHeaders, data: { expected_version: created.checkin.version, text: '不能修改', photo_media_id: photo.id, audio_media_id: null } })).ok()).toBe(false);

    await page.getByRole('button', { name: content.navigation.calendar, exact: true }).click();
    await page.getByLabel(groups.memberLabel).selectOption(String(peer.session.account.id));
    await page.locator('.calendar-day[data-today=true]').click();
    await expect(page.getByRole('dialog').locator('.checkin-record').filter({ hasText: taskName })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: content.navigation.stats, exact: true }).click();
    await page.getByLabel(groups.memberLabel).selectOption(String(peer.session.account.id));
    await expect(page.locator('.reports-bars li').filter({ hasText: taskName })).toContainText('1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.local/previews/groups-${testInfo.project.name}.png`, fullPage: true, animations: 'disabled' });

    await openConfigurationSettings(page);
    await page.getByLabel(groups.managementPassword, { exact: true }).fill('Manage-Test-2026');
    await page.getByRole('button', { name: groups.leave, exact: true }).click();
    await expect(page.getByRole('button', { name: groups.join, exact: true })).toBeVisible();
    await closeConfigurationSettings(page);
    expect((await page.request.get(`/api/v1/stats?start_date=${peer.session.today}&end_date=${peer.session.today}&account_id=${peer.session.account.id}`)).status()).toBe(403);
    expect((await page.request.get(photoURL)).ok()).toBe(false);
    await expect(page.getByLabel(groups.memberLabel)).toHaveCount(0);
  } finally {
    await request.post('/api/v1/groups/leave', { headers: peer.headers, data: { password: 'Manage-Test-2026' } });
    const viewerStateResponse = await page.request.get('/api/v1/session');
    if (viewerStateResponse.ok()) {
      const viewerState = await viewerStateResponse.json() as components['schemas']['SessionResponse'];
      await page.request.post('/api/v1/groups/leave', { headers: { Origin: 'http://127.0.0.1:15173', 'X-CSRF-Token': viewerState.csrf_token }, data: { password: 'Manage-Test-2026' } });
    }
    await outsiderContext.close();
  }
});
