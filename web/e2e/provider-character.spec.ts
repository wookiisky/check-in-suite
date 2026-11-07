import { expect, test } from '@playwright/test';
import type { components } from '../src/api/schema';
import { loginMain, openAppearance, closeAppearance, selectShopCategory, purchaseProduct, shopAPI } from './shop-navigation';
import { appearanceRequest } from './appearance-flow-fixtures';
import { characterSlots } from '../src/features/character/character3d-appearance';
import shop from '../src/features/shop/content.json' with { type: 'json' };
import appearance from '../src/features/shop/appearance-content.json' with { type: 'json' };
import preview from '../src/features/character/character-verification-content.json' with { type: 'json' };

type Appearance = components['schemas']['AppearanceState'];
type Product = components['schemas']['Product'];
type Task = components['schemas']['Task'];
type Camp = components['schemas']['CampResponse'];

// 两个身体与六槽商品通过正式购买和外观编辑器验证，重开后再核对保存事实。
test('只提供人形与骷髅，职业部件独立混穿，中箭与帽子互换且不改变脸和披风', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  await loginMain(page);
  await expect(page.locator('.character3d-preview').first()).toHaveAttribute('data-character-status', 'ready');
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const initial = await shopAPI<Appearance>(page, '/appearance');
  expect(initial.characters.map((item) => item.character_key)).toEqual(['kaykit-medium-v1', 'kaykit-skeleton-v1']);
  const faces = initial.wearables.filter((item) => item.slot === 'face');
  expect(faces.map((item) => item.name)).toEqual(['微笑脸', '骷髅', '裂纹骷髅', '红纹骷髅']);
  expect(initial.wearables.some((item) => item.model_asset_key.startsWith('kenney-'))).toBe(false);
  const skeleton = initial.characters.find((item) => item.character_key === 'kaykit-skeleton-v1')!;
  const bodies = await shopAPI<{ items: Product[] }>(page, '/products?type=character&limit=100');
  expect(bodies.items.every((item) => item.character_key === skeleton.character_key)).toBe(true);
  const skeletonOffer = bodies.items.find((item) => item.character_key === skeleton.character_key)!;
  const clothing = await shopAPI<{ items: Product[] }>(page, '/products?type=wearable&limit=100');
  const representativeKeys = { face: 'face-kaykit-skeletons-mage', head: 'kaykit-adventurers-knight-head', upper: 'kaykit-adventurers-knight-upper', lower: 'lower-barbarian-v1', shoes: 'shoes-barbarian-v1', back: 'kaykit-adventurers-mage-back-cape' };
  const selections = characterSlots.map((slot) => {
    const item = clothing.items.find((offer) => offer.wearable_key === representativeKeys[slot]);
    expect(item, `${slot}需要独立商品`).toBeDefined(); return item!;
  });
  const headOffers = clothing.items.filter((offer) => initial.wearables.find((wearable) => wearable.wearable_key === offer.wearable_key)?.slot === 'head');
  const arrow = headOffers.find((item) => item.wearable_key === 'head-arrow-v1')!;
  expect(arrow, '中箭必须作为头部商品提供').toBeDefined();
  const hat = selections[1]!;
  const greenFace = clothing.items.find((item) => item.wearable_key === 'face-kaykit-legacy-skeleton-minion')!;
  expect(greenFace).toBeDefined();
  const offers = [...new Map([skeletonOffer, ...selections, arrow, greenFace].map((item) => [item.id, item])).values()];
  const camp = await shopAPI<Camp>(page, '/camp');
  const required = offers.filter((item) => !item.owned).reduce((sum, item) => ({ coins: sum.coins + item.coin_price, diamonds: sum.diamonds + item.diamond_price }), { coins: 0, diamonds: 0 });
  await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
  const task = await shopAPI<Task>(page, '/management/tasks', 'POST', { category_id: null, name: `六槽混穿准备-${testInfo.project.name}-${crypto.randomUUID().slice(0, 6)}`, icon_key: 'book-v1', coin_reward: Math.max(0, required.coins + 100 - camp.wallet.coins), diamond_reward: Math.max(0, required.diamonds - camp.wallet.diamonds), daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true });
  await shopAPI(page, '/checkins', 'POST', { expected_today: camp.today, task_id: task.id, expected_task_version: task.version, text: '', photo_media_id: null, audio_media_id: null });
  await shopAPI(page, `/management/tasks/${task.id}`, 'PATCH', { category_id: task.category_id, name: task.name, icon_key: task.icon_key, coin_reward: task.coin_reward, diamond_reward: task.diamond_reward, daily_limit: task.daily_limit, weekdays: task.weekdays, enabled: false, expected_version: task.version });
  await shopAPI(page, '/management/lock', 'POST');
  if (!skeletonOffer.owned) {
    await page.reload(); await selectShopCategory(page, 'appearance', shop.types.character);
    await purchaseProduct(page, skeletonOffer);
  }
  for (const offer of offers.filter((item) => item.type === 'wearable' && !item.owned)) {
    const current = await shopAPI<Camp>(page, '/camp');
    await shopAPI(page, '/purchases', 'POST', { product_id: offer.id, expected_product_version: offer.version, expected_wallet_version: current.wallet.version });
  }
  const owned = await shopAPI<Appearance>(page, '/appearance');
  expect(owned.inventory.some((item) => owned.character_inventory?.some((body) => body.purchase_id === item.purchase_id))).toBe(false);
  const purchase = (offer: Product) => owned.inventory.find((item) => item.wearable_key === offer.wearable_key)!.purchase_id;
  try {
    await page.reload(); await openAppearance(page);
    let dialog = page.getByRole('dialog', { name: appearance.title, exact: true });
    await dialog.getByRole('group', { name: appearance.characterTitle, exact: true }).getByRole('radio', { name: skeleton.name, exact: true }).check();
    for (const [index, slot] of characterSlots.entries()) await dialog.locator(`input[name="${slot}_purchase_id"][value="${purchase(selections[index]!)}"]`).check();
    await dialog.locator(`input[name="head_purchase_id"][value="${purchase(arrow)}"]`).check();
    await expect(dialog.getByRole('button', { name: appearance.save, exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: appearance.save, exact: true }).click();
    await expect(dialog.getByText(appearance.saved, { exact: true })).toBeVisible();
    let saved = await shopAPI<Appearance>(page, '/appearance');
    expect(saved.character_key).toBe(skeleton.character_key);
    expect(saved.head_purchase_id).toBe(purchase(arrow));
    expect(saved.face_purchase_id).toBe(purchase(selections[0]!));
    expect(saved.back_purchase_id).toBe(purchase(selections[5]!));
    await dialog.locator('.appearance-preview').screenshot({ path: testInfo.outputPath('skeleton-six-slot-arrow.png') });
    await closeAppearance(page); await openAppearance(page);
    dialog = page.getByRole('dialog', { name: appearance.title, exact: true });
    await expect(dialog.locator(`input[name="head_purchase_id"][value="${purchase(arrow)}"]`)).toBeChecked();
    await dialog.locator(`input[name="head_purchase_id"][value="${purchase(hat)}"]`).check();
    await expect(dialog.locator(`input[name="head_purchase_id"][value="${purchase(arrow)}"]`)).not.toBeChecked();
    await expect(dialog.locator(`input[name="face_purchase_id"][value="${saved.face_purchase_id}"]`)).toBeChecked();
    await expect(dialog.locator(`input[name="back_purchase_id"][value="${saved.back_purchase_id}"]`)).toBeChecked();
    await expect(dialog.getByRole('button', { name: appearance.save, exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: appearance.save, exact: true }).click();
    await expect(dialog.getByText(appearance.saved, { exact: true })).toBeVisible();
    saved = await shopAPI<Appearance>(page, '/appearance');
    expect(saved.head_purchase_id).toBe(purchase(hat));
    await dialog.locator('.appearance-preview').screenshot({ path: testInfo.outputPath('skeleton-independent-face-hat-cape.png') });
    const human = owned.characters.find((item) => item.character_key === initial.default_character_key)!;
    await dialog.getByRole('group', { name: appearance.characterTitle, exact: true }).getByRole('radio', { name: human.name, exact: true }).check();
    const faceOptions = dialog.getByRole('group', { name: appearance.slots.face, exact: true }).getByRole('radio');
    const faceOptionNames = faces.map((item) => {
      if (item.wearable_key === human.defaults.face) return appearance.defaultOption.replace('{name}', item.name);
      if (item.wearable_key === skeleton.defaults.face) return appearance.initialFreeOption.replace('{name}', item.name);
      return item.name;
    });
    await expect(faceOptions).toHaveCount(faceOptionNames.length);
    expect(await faceOptions.evaluateAll((options) => options.map((item) => item.getAttribute('aria-label')))).toEqual(faceOptionNames);
    await expect(faceOptions.first()).toBeChecked();
    for (const [index, slot] of characterSlots.entries()) if (slot !== 'head' && slot !== 'face') await dialog.locator(`input[name="${slot}_purchase_id"][value="${purchase(selections[index]!)}"]`).check();
    await dialog.locator(`input[name="face_purchase_id"][value="${purchase(greenFace)}"]`).check();
    await expect(dialog.getByRole('button', { name: appearance.save, exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: appearance.save, exact: true }).click();
    await expect(dialog.getByText(appearance.saved, { exact: true })).toBeVisible();
    saved = await shopAPI<Appearance>(page, '/appearance');
    expect(saved.character_key).toBe(human.character_key); expect(saved.head_purchase_id).toBeNull();
    expect(saved.face_purchase_id).toBe(purchase(greenFace)); expect(saved.back_purchase_id).toBe(purchase(selections[5]!));
    await dialog.locator('.appearance-preview').screenshot({ path: testInfo.outputPath('human-shared-clothes-bare-head.png') });
    expect(errors).toEqual([]);
  } finally {
    const current = await shopAPI<Appearance>(page, '/appearance');
    await shopAPI(page, '/appearance', 'PUT', { ...appearanceRequest(initial), expected_version: current.version, ...Object.fromEntries(characterSlots.map((slot) => [`${slot}_free_wearable_key`, initial[`${slot}_free_wearable_key`] ?? null])) });
  }
});

// 原始动作仍由实际GLB中的clip驱动，只在独立检查页选中时临时加入准备资源。
test('独立人物检查按需播放原始动作，切换与返回待机不修改保存外观', async ({ page }, testInfo) => {
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await loginMain(page);
  await expect(page.locator('.character3d-preview').first()).toHaveAttribute('data-character-status', 'ready');
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const state = await shopAPI<Appearance>(page, '/appearance');
  const character = state.characters.find((item) => item.character_key === state.character_key)!;
  const sourceAnimations = state.preview_animations ?? character.preview_animations ?? [];
  expect(sourceAnimations.length, '完整素材目录必须登记原始动作').toBeGreaterThan(1);
  const canonicalURLs = new Set([character.model_url, ...Object.values(character.animations).map((item) => item.url), ...state.wearables.map((item) => item.model_url)]);
  const rawURLs = new Set(sourceAnimations.map((item) => item.url).filter((url) => !canonicalURLs.has(url)));
  const requested = new Set<string>();
  page.on('request', (request) => requested.add(new URL(request.url()).pathname));
  await page.goto('/character-preview.html');
  await expect(page.getByTestId('character-render-status')).toHaveText(preview.status.ready);
  expect([...rawURLs].some((url) => requested.has(url))).toBe(false);
  const first = sourceAnimations.find((item) => rawURLs.has(item.url)) ?? sourceAnimations[0]!;
  const label = preview.sourceAction.replace('{clip}', first.clip);
  const picker = page.getByLabel(preview.action, { exact: true });
  const value = await picker.getByRole('option', { name: label, exact: true }).first().getAttribute('value');
  await picker.selectOption(value!);
  await expect(page.locator('.character3d-preview')).toHaveAttribute('data-character-action', '_preview');
  await expect(page.getByTestId('character-render-status')).toHaveText(preview.status.ready);
  expect([...rawURLs].filter((url) => requested.has(url))).toEqual(rawURLs.has(first.url) ? [first.url] : []);
  await page.locator('.character3d-preview').screenshot({ path: testInfo.outputPath('source-character-animation.png') });
  await picker.selectOption('idle');
  await expect(page.locator('.character3d-preview')).toHaveAttribute('data-character-action', 'idle');
  await expect(page.getByTestId('character-render-status')).toHaveText(preview.status.ready);
  const after = await shopAPI<Appearance>(page, '/appearance');
  expect(after.version).toBe(state.version);
  expect(after.character_key).toBe(state.character_key);
  expect(after.upper_purchase_id).toBe(state.upper_purchase_id);
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
