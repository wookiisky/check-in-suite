import { draftFromAppearance, wearableFitsCharacter } from '../src/features/character/character3d-appearance';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { components } from '../src/api/schema';
import accountContent from '../src/content/zh-CN.json' with { type: 'json' };
import preview from '../src/features/character/character-verification-content.json' with { type: 'json' };

type Appearance = components['schemas']['AppearanceState'];

// 使用测试浏览器的真实 Cookie 和服务器 CSRF，初始化仅影响独立端到端数据库。
export async function appearanceAPI(page: Page, route: string, method = 'GET', data?: unknown) {
  const response = await page.request.get('/api/v1/session');
  expect(response.ok()).toBe(true);
  const session = await response.json() as components['schemas']['SessionResponse'];
  return page.request.fetch(`/api/v1${route}`, { method, ...(data === undefined ? {} : { data }), headers: { Origin: 'http://127.0.0.1:15173', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() } });
}

// 独立预览复用正式登录表单，不用伪造会话跳过 HTTP 授权。
export async function openCharacterPreview(page: Page) {
  await page.goto('/character-preview.html');
  await page.getByLabel(accountContent.account.username).fill('island-e2e');
  await page.getByLabel(accountContent.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: accountContent.account.login, exact: true }).click();
  await expect(page.getByTestId('character-render-status')).toHaveText(preview.status.ready);
}

// 从实际目录选出上装替代项；商品和订单仍通过正式购买事务生成。
export async function ownedAlternativeUpper(page: Page, name: string, wearableKey?: string) {
  const current = await (await appearanceAPI(page, '/appearance')).json() as Appearance;
  const body = current.characters.find((value) => value.character_key === current.character_key)!;
  const defaults = new Set(current.characters.flatMap((item) => Object.values(item.defaults)));
  const wearable = current.wearables.find((value) => value.slot === 'upper' && !defaults.has(value.wearable_key) && (!wearableKey || value.wearable_key === wearableKey) && wearableFitsCharacter(value, body, current.characters))!;
  expect(wearable, wearableKey ?? '需要可购买的替代上装').toBeDefined();
  let owned = current.inventory.find((value) => value.wearable_key === wearable.wearable_key);
  if (!owned) {
    expect((await appearanceAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' })).ok()).toBe(true);
    let fundingTask: components['schemas']['Task'] | null = null;
    let fundingRecord: components['schemas']['Checkin'] | null = null;
    try {
      const created = await appearanceAPI(page, '/management/products', 'POST', { type: 'wearable', name, asset_key: wearable.thumbnail_asset_key, wearable_key: wearable.wearable_key, description: '', coin_price: 0, diamond_price: 0, stock: null, enabled: true });
      expect(created.status()).toBe(201);
      const product = await created.json() as components['schemas']['Product'];
      let camp = await (await appearanceAPI(page, '/camp')).json() as components['schemas']['CampResponse'];
      // 撤销已消费的打卡奖励可能留下负余额，零价购买也必须满足正式余额规则。
      if (camp.wallet.coins < product.coin_price || camp.wallet.diamonds < product.diamond_price) {
        const task = await appearanceAPI(page, '/management/tasks', 'POST', { category_id: null, name: `${name}-余额准备`, icon_key: 'book-v1', coin_reward: Math.max(0, product.coin_price - camp.wallet.coins), diamond_reward: Math.max(0, product.diamond_price - camp.wallet.diamonds), daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true });
        expect(task.status()).toBe(201);
        fundingTask = await task.json() as components['schemas']['Task'];
        const checkin = await appearanceAPI(page, '/checkins', 'POST', { expected_today: camp.today, task_id: fundingTask.id, expected_task_version: fundingTask.version, text: '', photo_media_id: null, audio_media_id: null });
        expect(checkin.status()).toBe(201);
        fundingRecord = (await checkin.json() as components['schemas']['CheckinResult']).checkin;
        camp = await (await appearanceAPI(page, '/camp')).json() as components['schemas']['CampResponse'];
      }
      const purchased = await appearanceAPI(page, '/purchases', 'POST', { product_id: product.id, expected_product_version: product.version, expected_wallet_version: camp.wallet.version });
      expect(purchased.status(), await purchased.text()).toBe(201);
      const result = await purchased.json() as components['schemas']['PurchaseResult'];
      owned = { purchase_id: result.purchase.id, wearable_key: wearable.wearable_key };
    } finally {
      if (fundingRecord) expect((await appearanceAPI(page, `/checkins/${fundingRecord.id}`, 'DELETE', { expected_version: fundingRecord.version })).ok()).toBe(true);
      if (fundingTask) expect((await appearanceAPI(page, `/management/tasks/${fundingTask.id}`, 'DELETE', { expected_version: fundingTask.version })).status()).toBe(204);
      expect((await appearanceAPI(page, '/management/lock', 'POST')).status()).toBe(204);
    }
  }
  return { ...owned, wearable };
}

// 构造整套外观请求，明确保留六个默认空值。
export function appearanceRequest(state: Appearance) {
  return { expected_version: state.version, ...draftFromAppearance(state) };
}
