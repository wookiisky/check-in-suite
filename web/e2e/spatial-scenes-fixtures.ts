import { expect } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type { components } from '../src/api/schema';
import { loginMain, purchaseProduct, selectShopCategory, shopAPI } from './shop-navigation';
import spatial from '../src/features/island/three/spatial-content.json' with { type: 'json' };
import sceneContent from '../src/features/island/three/scene-picker-content.json' with { type: 'json' };
import browserContent from '../src/features/island/three/spatial-inventory-content.json' with { type: 'json' };

export type SpatialState=components['schemas']['SpatialIslandState'];
export type Placement=components['schemas']['SpatialPlacement'];
type Product=components['schemas']['Product'];
type Camp=components['schemas']['CampResponse'];
type Task=components['schemas']['Task'];
export const sceneKeys=['seaside-v1','forest-courtyard-v1','lakeside-garden-v1'] as const;
export const houseKeys=['tiny-treats-cottage-v1','tiny-treats-courtyard-v1'] as const;

// 真实会话和版本决定读取目标，不从当前画面推断保存事实。
export async function readScene(page:Page,key:string):Promise<SpatialState> {
  return shopAPI(page,`/island/layout?scene_key=${encodeURIComponent(key)}`);
}

// 完整保存使用刚读取的目标场景版本；其他场景不跟随修改。
export async function saveScene(page:Page,state:SpatialState,placements:Placement[]):Promise<SpatialState> {
  return shopAPI(page,'/island/layout','PUT',{expected_version:state.version,scene_key:state.scene_key,environment_key:state.environment_key,placements});
}

// 测试余额通过真实任务及打卡取得，全部数据仅位于Playwright临时库。
async function prepareBalance(page:Page,offers:Product[]) {
  const camp=await shopAPI<Camp>(page,'/camp');
  const required=offers.filter(item=>!item.owned).reduce((sum,item)=>sum+item.coin_price,0)+100;
  if(camp.wallet.coins>=required&&camp.wallet.diamonds>=0)return;
  await shopAPI(page,'/management/unlock','POST',{password:'Manage-Test-2026'});
  const task=await shopAPI<Task>(page,'/management/tasks','POST',{category_id:null,name:`场景验收准备-${crypto.randomUUID().slice(0,8)}`,icon_key:'book-v1',coin_reward:Math.max(0,required-camp.wallet.coins),diamond_reward:Math.max(0,-camp.wallet.diamonds),daily_limit:1,weekdays:[1,2,3,4,5,6,7],enabled:true});
  await shopAPI(page,'/checkins','POST',{expected_today:camp.today,task_id:task.id,expected_task_version:task.version,text:'',photo_media_id:null,audio_media_id:null});
  await shopAPI(page,`/management/tasks/${task.id}`,'PATCH',{category_id:task.category_id,name:task.name,icon_key:task.icon_key,coin_reward:task.coin_reward,diamond_reward:task.diamond_reward,daily_limit:task.daily_limit,weekdays:task.weekdays,enabled:false,expected_version:task.version});
  await shopAPI(page,'/management/lock','POST');
}

// 首条流程实际操作四次购买，后续流程可独立运行并复用已拥有资格。
export async function prepareScenes(page:Page,viaUI=false) {
  await loginMain(page);
  const state=await readScene(page,sceneKeys[0]);
  const definitions=houseKeys.map(key=>state.catalog.find(item=>item.house_key===key)!);
  expect(definitions.every(Boolean),'两栋正式房型应已注册').toBe(true);
  let products=(await shopAPI<{items:Product[]}>(page,'/products')).items;
  const offers=[...sceneKeys.slice(1).map(key=>products.find(item=>item.type==='scene'&&item.scene_key===key)!),...definitions.map(definition=>products.find(item=>item.type==='island'&&item.asset_key===definition.thumbnail_asset_key)!)];
  expect(offers.every(Boolean),'两场景及两栋主屋应有正式报价').toBe(true);
  await prepareBalance(page,offers);
  await page.reload();
  for(const original of offers) {
    products=(await shopAPI<{items:Product[]}>(page,'/products')).items;
    const offer=products.find(item=>item.id===original.id)!;
    if(offer.owned)continue;
    if(viaUI) {
      await selectShopCategory(page,offer.type==='scene'?'scene':'island');
      await purchaseProduct(page,offer);
    } else {
      const camp=await shopAPI<Camp>(page,'/camp');
      await shopAPI(page,'/purchases','POST',{product_id:offer.id,expected_product_version:offer.version,expected_wallet_version:camp.wallet.version});
    }
  }
  return definitions;
}

// 先清空全部场景再恢复，跨场景唯一占用不能使测试清理顺序影响结果。
export async function restoreScenes(page:Page,original:SpatialState[]) {
  for(const key of sceneKeys) {
    const current=await readScene(page,key);
    if(current.placements.length)await saveScene(page,current,[]);
  }
  for(const state of original) {
    const current=await readScene(page,state.scene_key);
    await shopAPI(page,'/island/layout','PUT',{expected_version:current.version,scene_key:state.scene_key,environment_key:state.environment_key,placements:state.placements});
  }
}

// 每条流程显式从海边进入，设备偏好只用于之后的刷新恢复断言。
export async function openScenes(page:Page) {
  await page.evaluate(key=>localStorage.removeItem(key),sceneContent.storageKey);
  await page.goto('/island-3d.html');
  await expect(page.getByRole('button',{name:spatial.edit,exact:true})).toBeEnabled();
  await expect(page.getByRole('region',{name:spatial.scene,exact:true})).toHaveAttribute('data-character-status','ready');
}

// 场景切换必须经过可用场景列表，未保存状态由各流程明确选择。
export async function chooseScene(page:Page,key:string) {
  const choices=await shopAPI<{items:components['schemas']['SpatialSceneOption'][]}>(page,'/island/scenes');
  const target=choices.items.find(item=>item.scene_key===key)!;
  await page.getByRole('button',{name:sceneContent.open,exact:true}).click();
  await page.getByRole('dialog',{name:sceneContent.title,exact:true}).getByRole('button',{name:sceneContent.go.replace('{name}',target.name),exact:true}).click();
}

// 标题和真实人物准备完成共同证明新场景已读取并渲染。
export async function expectScene(page:Page,key:string) {
  const choices=await shopAPI<{items:components['schemas']['SpatialSceneOption'][]}>(page,'/island/scenes');
  await expect(page.getByRole('heading',{name:choices.items.find(item=>item.scene_key===key)!.name,exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:spatial.edit,exact:true})).toBeEnabled();
  await expect(page.getByRole('region',{name:spatial.scene,exact:true})).toHaveAttribute('data-character-status','ready');
}

// 窄屏选中物品后会收起列表，下一次选择必须显式展开。
export async function inventory(page:Page):Promise<Locator> {
  const expand=page.getByRole('button',{name:spatial.showInventory,exact:true});
  if(await expand.isVisible())await expand.click();
  return page.getByRole('complementary',{name:spatial.inventory,exact:true});
}

// 搜索定位一件真实库存；筛选不会改变完整所有权或布局。
export async function chooseInventory(page:Page,name:string,placed=false) {
  const panel=await inventory(page);
  await panel.getByRole('searchbox',{name:browserContent.search,exact:true}).fill(name);
  await panel.getByRole('button',{name:(placed?spatial.select:spatial.add).replace('{name}',name),exact:true}).click();
  await expect(panel.getByRole('region',{name,exact:true}),'所选库存应实际进入草稿，而非只显示可点击按钮').toBeVisible();
}

// 截图前等待实际渲染帧，保留页面与Canvas供四向剖墙和窄屏检查。
export async function captureScene(page:Page,testInfo:TestInfo,name:string) {
  await expect(page.getByRole('region',{name:spatial.scene,exact:true})).toHaveAttribute('data-character-status','ready');
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await page.getByRole('region',{name:spatial.scene,exact:true}).locator('canvas').screenshot({path:testInfo.outputPath(`${name}-canvas.png`),style:'.spatial-island > :not(.spatial-stage) { visibility: hidden !important; }'});
  await page.screenshot({path:testInfo.outputPath(`${name}-page.png`),fullPage:true});
}
