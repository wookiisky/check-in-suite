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

// 从实际目录选出上衣替代项；商品和订单仍通过正式购买事务生成。
export async function ownedAlternativeUpper(page: Page, name: string) {
  const current = await (await appearanceAPI(page, '/appearance')).json() as Appearance;
  const body = current.characters.find((value) => value.character_key === current.character_key)!;
  const wearable = current.wearables.find((value) => value.slot === 'upper' && value.character_key === body.character_key && value.wearable_key !== body.defaults.upper)!;
  let owned = current.inventory.find((value) => value.wearable_key === wearable.wearable_key);
  if (!owned) {
    expect((await appearanceAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' })).ok()).toBe(true);
    const created = await appearanceAPI(page, '/management/products', 'POST', { type: 'wearable', name, asset_key: wearable.thumbnail_asset_key, wearable_key: wearable.wearable_key, description: '', coin_price: 0, diamond_price: 0, stock: null, enabled: true });
    expect(created.status()).toBe(201);
    const product = await created.json() as components['schemas']['Product'];
    const camp = await (await appearanceAPI(page, '/camp')).json() as components['schemas']['CampResponse'];
    const purchased = await appearanceAPI(page, '/purchases', 'POST', { product_id: product.id, expected_product_version: product.version, expected_wallet_version: camp.wallet.version });
    expect(purchased.status()).toBe(201);
    const result = await purchased.json() as components['schemas']['PurchaseResult'];
    owned = { purchase_id: result.purchase.id, wearable_key: wearable.wearable_key };
    expect((await appearanceAPI(page, '/management/lock', 'POST')).status()).toBe(204);
  }
  return { ...owned, wearable };
}

// 构造整套外观请求，明确保留四个默认空值。
export function appearanceRequest(state: Appearance) {
  return { expected_version: state.version, character_key: state.character_key, hair_purchase_id: state.hair_purchase_id, upper_purchase_id: state.upper_purchase_id, lower_purchase_id: state.lower_purchase_id, shoes_purchase_id: state.shoes_purchase_id };
}
