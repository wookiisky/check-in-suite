import { expect, test, type Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import achievement from '../src/features/achievements/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';

// 配置创建共享恢复验证，但各表单仍使用自己的可访问名称与恢复入口。
interface CreationFlow {
  kind: string; // 为临时实体和用例提供可区分的名称。
  section: string; // 配置导航中的目标分区。
  create: string; // 打开新增表单的操作。
  name: string; // 当前表单的名称字段。
  save: string; // 首次提交操作。
  pending: string; // 未知结果提示。
  recover: string; // 列表及表单的恢复操作。
  endpoint: string; // 用于真实提交后丢弃响应的创建路径。
  listEndpoint: string; // 从持久结果核对创建数量的读取路径。
  reopen: boolean; // 商品、成就先重开表单，类别与任务从列表直接恢复。
}

const creationFlows: CreationFlow[] = [
  { kind: '类别', section: content.navigation.tasks, create: checkin.newCategory, name: checkin.name, save: checkin.save, pending: checkin.configUnknown, recover: checkin.retryConfig, endpoint: '/management/categories', listEndpoint: '/categories?include_inactive=true', reopen: false },
  { kind: '任务', section: content.navigation.tasks, create: checkin.newTask, name: checkin.name, save: checkin.save, pending: checkin.configUnknown, recover: checkin.retryConfig, endpoint: '/management/tasks', listEndpoint: '/tasks?include_inactive=true', reopen: false },
  { kind: '商品', section: content.navigation.products, create: shop.addProduct, name: shop.name, save: shop.save, pending: shop.createPending, recover: shop.recoverCreate, endpoint: '/management/products', listEndpoint: '/products?include_inactive=true', reopen: true },
  { kind: '成就', section: content.navigation.achievementManagement, create: achievement.new, name: achievement.name, save: achievement.save, pending: achievement.pendingCreate, recover: achievement.retryCreate, endpoint: '/management/achievements', listEndpoint: '/management/achievements', reopen: true },
];

// 每次使用真实登录和管理密码，不从测试外复用授权状态。
async function enterManagement(page: Page) {
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await unlockManagement(page);
}

// 在正常登录不变的情况下重新取得管理授权。
async function unlockManagement(page: Page) {
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
}

// 用当前浏览器会话核对持久结果，写入仍执行实际来源与CSRF检查。
async function sessionRequest(page: Page, path: string, method = 'GET') {
  const sessionResponse = await page.request.get('/api/v1/session');
  expect(sessionResponse.status()).toBe(200);
  const session = await sessionResponse.json() as components['schemas']['SessionResponse'];
  return page.request.fetch(`/api/v1${path}`, {
    method,
    headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token },
  });
}

for (const flow of creationFlows) {
  test(`${flow.kind}配置提交已成功但响应丢失，关闭后恢复仍只创建一条`, async ({ page }, testInfo) => {
    const name = `恢复${flow.kind}-${testInfo.project.name}-${Date.now()}`;
    await enterManagement(page);
    await page.getByRole('navigation', { name: content.navigation.management, exact: true })
      .getByRole('button', { name: flow.section, exact: true }).click();
    await page.getByRole('button', { name: flow.create, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(flow.name, { exact: true }).fill(name);

    const submissions: { key: string | undefined; body: string | null }[] = [];
    let createdID = '';
    await page.route(`**/api/v1${flow.endpoint}`, async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      submissions.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
      if (submissions.length === 1) {
        // 先让真实数据库提交，再丢弃浏览器响应，证明恢复的不是虚构成功。
        const response = await route.fetch();
        expect(response.status(), await response.text()).toBe(201);
        createdID = (await response.json() as { id: string }).id;
        await route.abort('failed');
      } else await route.continue();
    });
    await dialog.getByRole('button', { name: flow.save, exact: true }).click();
    await expect(dialog.getByText(flow.pending, { exact: true })).toBeVisible();
    await expect(dialog.getByLabel(flow.name, { exact: true })).toHaveValue(name);
    await expect(dialog.getByLabel(flow.name, { exact: true })).toBeDisabled();

    const readCreated = async () => {
      const response = await sessionRequest(page, flow.listEndpoint);
      expect(response.status()).toBe(200);
      const list = await response.json() as { items: { id: string; name: string }[] };
      return list.items.filter((item) => item.name === name);
    };
    expect(await readCreated()).toEqual([expect.objectContaining({ id: createdID, name })]);
    await dialog.getByRole('button', { name: content.common.close, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: flow.create, exact: true })).toBeDisabled();
    await page.getByRole('button', { name: flow.recover, exact: true }).click();
    if (flow.reopen) {
      await expect(dialog.getByLabel(flow.name, { exact: true })).toHaveValue(name);
      await expect(dialog.getByLabel(flow.name, { exact: true })).toBeDisabled();
      await dialog.getByRole('button', { name: flow.recover, exact: true }).click();
    }
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: flow.create, exact: true })).toBeEnabled();
    expect(submissions).toHaveLength(2);
    expect(submissions[0]!.key).toBeTruthy();
    expect(submissions[1]).toEqual(submissions[0]);
    expect(await readCreated()).toEqual([expect.objectContaining({ id: createdID, name })]);
    await page.unroute(`**/api/v1${flow.endpoint}`);
  });
}

// 服务端撤销授权后先拒绝旧表单，恢复授权后才允许核对保留的原命令。
test('管理授权被撤销后拒绝旧任务表单，重新解锁可恢复原命令', async ({ page }, testInfo) => {
  const name = `撤权任务-${testInfo.project.name}-${Date.now()}`;
  await enterManagement(page);
  await page.getByRole('navigation', { name: content.navigation.management, exact: true })
    .getByRole('button', { name: content.navigation.tasks, exact: true }).click();
  await page.getByRole('button', { name: checkin.newTask, exact: true }).click();
  await page.getByRole('dialog').getByLabel(checkin.name, { exact: true }).fill(name);
  expect((await sessionRequest(page, '/management/lock', 'POST')).status()).toBe(204);

  const submissions: { key: string | undefined; body: string | null }[] = [];
  await page.route('**/api/v1/management/tasks', async (route) => {
    if (route.request().method() === 'POST')
      submissions.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
    await route.continue();
  });
  const rejected = page.waitForResponse((response) => response.url().endsWith('/api/v1/management/tasks') && response.request().method() === 'POST');
  await page.getByRole('dialog').getByRole('button', { name: checkin.save, exact: true }).click();
  const response = await rejected;
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'MANAGEMENT_REQUIRED' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(content.account.managementExpired, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: content.account.loginTitle, exact: true })).toHaveCount(0);
  await unlockManagement(page);
  const tasksResponse = await sessionRequest(page, '/tasks?include_inactive=true');
  const tasks = await tasksResponse.json() as { items: components['schemas']['Task'][] };
  expect(tasks.items.some((task) => task.name === name)).toBe(false);
  await page.getByRole('navigation', { name: content.navigation.management, exact: true })
    .getByRole('button', { name: content.navigation.tasks, exact: true }).click();
  await expect(page.getByText(checkin.configUnknown, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: checkin.newTask, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: checkin.retryConfig, exact: true }).click();
  await expect(page.getByRole('button', { name: checkin.newTask, exact: true })).toBeEnabled();
  await expect(page.getByText(checkin.configUnknown, { exact: true })).toHaveCount(0);
  const restoredResponse = await sessionRequest(page, '/tasks?include_inactive=true');
  expect(restoredResponse.status()).toBe(200);
  const restored = await restoredResponse.json() as { items: components['schemas']['Task'][] };
  expect(restored.items.filter((task) => task.name === name)).toHaveLength(1);
  expect(submissions).toHaveLength(2);
  expect(submissions[0]!.key).toBeTruthy();
  expect(submissions[1]).toEqual(submissions[0]);
  await page.unroute('**/api/v1/management/tasks');
});

// 锁定请求失联时不声称已撤权，真实会话状态与重试结果同时验证。
test('退出管理请求失败提示尚未锁定，重试后服务端授权确实撤销', async ({ page }) => {
  await enterManagement(page);
  let attempts = 0;
  await page.route('**/api/v1/management/lock', async (route) => {
    attempts += 1;
    if (attempts === 1) await route.abort('failed');
    else await route.continue();
  });
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toHaveCount(0);
  await expect(page.getByText(content.account.lockUnconfirmed, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: content.navigation.management, exact: true })).toBeDisabled();
  const beforeRetry = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  expect(beforeRetry.management_expires_at).not.toBeNull();
  await page.getByRole('button', { name: content.account.retryLock, exact: true }).click();
  await expect(page.getByText(content.account.lockUnconfirmed, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: content.navigation.management, exact: true })).toBeEnabled();
  const afterRetry = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  expect(afterRetry.management_expires_at).toBeNull();
  expect(attempts).toBe(2);
  await page.unroute('**/api/v1/management/lock');
});
