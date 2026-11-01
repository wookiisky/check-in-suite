import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type { components } from '../src/api/schema';
import { closeAppearance, loginMain, openAppearance, shopAPI } from './shop-navigation';
import appearance from '../src/features/shop/appearance-content.json' with { type: 'json' };

type Appearance=components['schemas']['AppearanceState'];
type Product=components['schemas']['Product'];
type Task=components['schemas']['Task'];
type Camp=components['schemas']['CampResponse'];
type Character=components['schemas']['CharacterDefinition'];
const slots=['hair','upper','lower','shoes'] as const;
const defaultSamples=[
  'kenney-prototype-kit-figurine',
  'kenney-blocky-characters-a',
  'kenney-mini-characters-male-a',
  'kenney-space-kit-alien',
  'kenney-animated-characters-protagonists-criminalmalea',
];
// 默认覆盖五个制作来源，定向修复复用同一购买和换装流程。
const samples=process.env.ISLAND_E2E_KENNEY_ONLY?[process.env.ISLAND_E2E_KENNEY_ONLY]:defaultSamples;

// 报价搜索必须作用于完整目录，不能假设样例恰好在首批商品中。
async function characterOffers(page:Page,state:Appearance) {
  const offers:Product[]=[];
  for(const key of samples) {
    const character=state.characters.find(item=>item.character_key===key);
    expect(character,`正式目录缺少样例 ${key}`).toBeDefined();
    const result=await shopAPI<{items:Product[]}>(page,`/products?type=character&search=${encodeURIComponent(character!.name)}&limit=100`);
    const offer=result.items.find(item=>item.character_key===key);
    expect(offer,`完整搜索未找到样例报价 ${key}`).toBeDefined();offers.push(offer!);
  }
  const beard=state.wearables.find(item=>item.wearable_key==='hair-barbarian-v1');
  expect(beard,'检查胡须必须使用正式独立服装').toBeDefined();
  const result=await shopAPI<{items:Product[]}>(page,`/products?type=wearable&search=${encodeURIComponent(beard!.name)}&limit=100`);
  const beardOffer=result.items.find(item=>item.wearable_key===beard!.wearable_key);
  expect(beardOffer,'非免费胡须需要真实可购买报价').toBeDefined();offers.push(beardOffer!);
  return offers;
}

// 在隔离库通过真实任务和打卡准备余额，购买仍执行正式钱包版本校验。
async function purchaseSamples(page:Page,offers:Product[]) {
  const camp=await shopAPI<Camp>(page,'/camp');
  const required=offers.filter(item=>!item.owned).reduce((sum,item)=>sum+item.coin_price,0)+100;
  await shopAPI(page,'/management/unlock','POST',{password:'Manage-Test-2026'});
  const task=await shopAPI<Task>(page,'/management/tasks','POST',{category_id:null,name:`Kenney换装准备-${crypto.randomUUID().slice(0,8)}`,icon_key:'book-v1',coin_reward:Math.max(0,required-camp.wallet.coins),diamond_reward:Math.max(0,-camp.wallet.diamonds),daily_limit:1,weekdays:[1,2,3,4,5,6,7],enabled:true});
  await shopAPI(page,'/checkins','POST',{expected_today:camp.today,task_id:task.id,expected_task_version:task.version,text:'',photo_media_id:null,audio_media_id:null});
  await shopAPI(page,`/management/tasks/${task.id}`,'PATCH',{category_id:task.category_id,name:task.name,icon_key:task.icon_key,coin_reward:task.coin_reward,diamond_reward:task.diamond_reward,daily_limit:task.daily_limit,weekdays:task.weekdays,enabled:false,expected_version:task.version});
  await shopAPI(page,'/management/lock','POST');
  for(const offer of offers) {
    if(offer.owned)continue;
    const current=await shopAPI<Camp>(page,'/camp');
    await shopAPI(page,'/purchases','POST',{product_id:offer.id,expected_product_version:offer.version,expected_wallet_version:current.wallet.version});
  }
}

// 数据身份、真实模型请求和ready状态共同排除仍在显示上一人物的情况。
async function expectModel(page:Page,dialog:Locator,character:Character,resources:ReadonlySet<string>) {
  const preview=dialog.locator('.character3d-preview');
  await expect(preview).toHaveAttribute('data-character-key',character.character_key);
  await expect.poll(()=>resources.has(character.model_url)).toBe(true);
  await expect(preview).toHaveAttribute('data-character-status','ready');
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(preview).toHaveAttribute('data-character-status','ready');
  await expect(dialog.getByText(appearance.previewFailed,{exact:true})).toHaveCount(0);
}

// 完整模型截图保留身体、头脸和双手，供与源头型和服装组合对照。
async function captureModel(dialog:Locator,testInfo:TestInfo,name:string) {
  await dialog.locator('.appearance-preview').scrollIntoViewIfNeeded();
  await dialog.locator('.appearance-preview').screenshot({path:testInfo.outputPath(`${name}.png`)});
}

// 保存确认和再次读取是两个证据，不能只凭草稿控件被选中认定已落库。
async function saveAppearance(page:Page,dialog:Locator) {
  await expect(dialog.getByRole('button',{name:appearance.save,exact:true})).toBeEnabled();
  await dialog.getByRole('button',{name:appearance.save,exact:true}).click();
  await expect(dialog.getByText(appearance.saved,{exact:true})).toBeVisible();
  return shopAPI<Appearance>(page,'/appearance');
}

// 五类样例验证双向四槽、初始免费衣物和独立胡须，避免用全组合代替关键边界。
test('Kenney人物真实购买后双向共用四槽并保存重开，胡须不丢脸部',async({page},testInfo)=>{
  test.setTimeout(240_000);
  await loginMain(page);
  await expect(page.locator('.character3d-preview').first()).toHaveAttribute('data-character-status','ready');
  const initial=await shopAPI<Appearance>(page,'/appearance');
  const defaultCharacter=initial.characters.find(item=>item.character_key===initial.default_character_key)!;
  expect(defaultCharacter).toBeDefined();
  const offers=await characterOffers(page,initial);
  await purchaseSamples(page,offers);
  await page.reload();
  const errors:string[]=[];
  const resources=new Set(await page.evaluate(()=>performance.getEntriesByType('resource').map(item=>new URL(item.name).pathname)));
  page.on('request',request=>resources.add(new URL(request.url()).pathname));
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  const owned=await shopAPI<Appearance>(page,'/appearance');
  const beardPurchase=owned.inventory.find(item=>item.wearable_key==='hair-barbarian-v1')!;
  expect(beardPurchase).toBeDefined();
  try {
    for(const [index,key] of samples.entries()) {
      const character=owned.characters.find(item=>item.character_key===key)!;
      const purchase=owned.character_inventory!.find(item=>item.character_key===key)!;
      expect(purchase).toBeDefined();
      expect(owned.inventory.filter(item=>item.purchase_id===purchase.purchase_id)).toHaveLength(4);
      expect(character.body_key).toBe(defaultCharacter.body_key);expect(character.rig_key).toBe(defaultCharacter.rig_key);
      await openAppearance(page);
      let dialog=page.getByRole('dialog',{name:appearance.title,exact:true});
      await dialog.getByRole('group',{name:appearance.characterTitle,exact:true}).getByRole('radio',{name:character.name,exact:true}).check();
      for(const slot of slots)await dialog.locator(`input[name="${slot}_purchase_id"][value="${defaultCharacter.defaults[slot]}"]`).check();
      await expectModel(page,dialog,character,resources);
      let saved=await saveAppearance(page,dialog);
      expect(saved.character_key).toBe(key);
      for(const slot of slots){expect(saved[`${slot}_purchase_id`]).toBeNull();expect(saved[`${slot}_free_wearable_key`]).toBe(defaultCharacter.defaults[slot]);}
      await captureModel(dialog,testInfo,`${index}-kenney-rogue`);
      await closeAppearance(page);await openAppearance(page);
      dialog=page.getByRole('dialog',{name:appearance.title,exact:true});
      await expect(dialog.getByRole('group',{name:appearance.characterTitle,exact:true}).getByRole('radio',{name:character.name,exact:true})).toBeChecked();
      for(const slot of slots)await expect(dialog.locator(`input[name="${slot}_purchase_id"][value="${defaultCharacter.defaults[slot]}"]`)).toBeChecked();

      await dialog.locator(`input[name="hair_purchase_id"][value="${beardPurchase.purchase_id}"]`).check();
      await expectModel(page,dialog,character,resources);
      saved=await saveAppearance(page,dialog);expect(saved.hair_purchase_id).toBe(beardPurchase.purchase_id);
      await captureModel(dialog,testInfo,`${index}-kenney-beard`);

      await dialog.getByRole('group',{name:appearance.characterTitle,exact:true}).getByRole('radio',{name:defaultCharacter.name,exact:true}).check();
      for(const slot of slots)await dialog.locator(`input[name="${slot}_purchase_id"][value="${purchase.purchase_id}"]`).check();
      await expectModel(page,dialog,defaultCharacter,resources);
      saved=await saveAppearance(page,dialog);
      expect(saved.character_key).toBe(defaultCharacter.character_key);
      for(const slot of slots)expect(saved[`${slot}_purchase_id`]).toBe(purchase.purchase_id);
      await captureModel(dialog,testInfo,`${index}-default-kenney-clothes`);
      await closeAppearance(page);await openAppearance(page);
      dialog=page.getByRole('dialog',{name:appearance.title,exact:true});
      await expect(dialog.getByRole('group',{name:appearance.characterTitle,exact:true}).getByRole('radio',{name:defaultCharacter.name,exact:true})).toBeChecked();
      for(const slot of slots)await expect(dialog.locator(`input[name="${slot}_purchase_id"][value="${purchase.purchase_id}"]`)).toBeChecked();
      await expectModel(page,dialog,defaultCharacter,resources);await closeAppearance(page);
    }
    expect(errors).toEqual([]);
  } finally {
    const current=await shopAPI<Appearance>(page,'/appearance');
    await shopAPI(page,'/appearance','PUT',{expected_version:current.version,character_key:initial.character_key,...Object.fromEntries(slots.flatMap(slot=>[[`${slot}_purchase_id`,initial[`${slot}_purchase_id`]],[`${slot}_free_wearable_key`,initial[`${slot}_free_wearable_key`]??null]]))});
  }
});
