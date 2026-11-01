import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { components } from '../src/api/schema';
import { shopAPI } from './shop-navigation';
import { captureScene, chooseInventory, chooseScene, expectScene, houseKeys, inventory, openScenes, prepareScenes, readScene, restoreScenes, saveScene, sceneKeys } from './spatial-scenes-fixtures';
import type { SpatialState } from './spatial-scenes-fixtures';
import content from '../src/features/island/three/spatial-content.json' with { type: 'json' };
import sceneContent from '../src/features/island/three/scene-picker-content.json' with { type: 'json' };
import browserContent from '../src/features/island/three/spatial-inventory-content.json' with { type: 'json' };

test.use({actionTimeout:15_000});

// 网络失败用例会明确中止响应；shader错误和未捕获异常始终不能被忽略。
function renderErrors(page:Page) {
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('Failed to load resource'))errors.push(message.text());});
  return errors;
}

// 当前UI产生的完整布局由服务端独立读回，不以成功提示代替持久化事实。
async function saveEditing(page:Page) {
  await expect(page.getByRole('button',{name:content.save,exact:true})).toBeEnabled();
  await page.getByRole('button',{name:content.save,exact:true}).click();
  await expect(page.getByText(content.saved,{exact:true})).toBeVisible();
}

// 模型请求与后续渲染帧都完成后才检查实际房屋画面。
async function waitHouse(page:Page,state:SpatialState) {
  const url=state.scene.house?.model_url;
  expect(url).toBeTruthy();
  const profile=state.scene.house?.entry_height_profile;
  expect(profile?.length,'正式响应应包含实际模型的门廊与台阶高度').toBeGreaterThan(1);
  expect(profile?.[0]?.y_cm).toBe(state.scene.house?.floor_height_cm);
  expect(profile?.at(-1)?.y_cm).toBe(0);
  await expect.poll(()=>page.evaluate(modelURL=>performance.getEntriesByType('resource').some(entry=>new URL(entry.name).pathname===modelURL),url!)).toBe(true);
  await expect(page.getByText(content.sceneError,{exact:true})).toBeHidden();
}

// 首条旅程购买完整内容，并证明空场景、独立保存与共享库存搬运。
test('购买两场景和两栋主屋，独立布置并收起搬运同一实例',async({page},testInfo)=>{
  test.setTimeout(150_000);
  const houses=await prepareScenes(page,true),errors=renderErrors(page);
  const original=await Promise.all(sceneKeys.map(key=>readScene(page,key)));
  try {
    for(const key of sceneKeys.slice(1))await saveScene(page,await readScene(page,key),[]);
    await openScenes(page);
    await chooseScene(page,sceneKeys[1]);await expectScene(page,sceneKeys[1]);
    const blank=await readScene(page,sceneKeys[1]);
    expect(blank.placements).toEqual([]);expect(blank.scene.house).toBeNull();
    await expect(page.getByRole('button',{name:content.enter,exact:true})).toBeDisabled();
    await page.getByRole('button',{name:content.activities.walk,exact:true}).click();
    await expect(page.getByRole('region',{name:content.scene,exact:true})).toHaveAttribute('data-actor-phase','walking');
    await page.getByRole('button',{name:content.activities.rest,exact:true}).click();
    await captureScene(page,testInfo,'forest-without-house');

    const lakeBefore=await readScene(page,sceneKeys[2]);
    await page.getByRole('button',{name:content.edit,exact:true}).click();
    await chooseInventory(page,houses[0]!.name);
    await saveEditing(page);
    const forest=await readScene(page,sceneKeys[1]),placement=forest.placements.find(item=>item.item_key===houses[0]!.item_key)!;
    expect(placement).toBeDefined();expect(forest.scene.house?.house_key).toBe(houseKeys[0]);
    expect((await readScene(page,sceneKeys[2])).version).toBe(lakeBefore.version);
    await chooseScene(page,sceneKeys[2]);await expectScene(page,sceneKeys[2]);
    await page.getByRole('button',{name:content.edit,exact:true}).click();
    const panel=await inventory(page);
    await panel.getByRole('searchbox',{name:browserContent.search,exact:true}).fill(houses[0]!.name);
    await expect(panel.getByRole('button',{name:content.add.replace('{name}',houses[0]!.name),exact:true})).toBeDisabled();
    const sceneList=await shopAPI<{items:components['schemas']['SpatialSceneOption'][]}>(page,'/island/scenes');
    await expect(panel.getByText(browserContent.placedElsewhere.replace('{name}',sceneList.items.find(item=>item.scene_key===sceneKeys[1])!.name),{exact:true})).toBeVisible();
    const session=await shopAPI<components['schemas']['SessionResponse']>(page,'/session');
    const rejected=await page.request.put('/api/v1/island/layout',{headers:{Origin:'http://127.0.0.1:15173','X-CSRF-Token':session.csrf_token},data:{expected_version:lakeBefore.version,scene_key:sceneKeys[2],environment_key:lakeBefore.environment_key,placements:[placement]}});
    expect(rejected.status()).toBe(400);
    expect((await readScene(page,sceneKeys[2])).version).toBe(lakeBefore.version);
    await page.getByRole('button',{name:content.cancel,exact:true}).click();

    await chooseScene(page,sceneKeys[1]);await expectScene(page,sceneKeys[1]);
    await page.getByRole('button',{name:content.edit,exact:true}).click();
    await chooseInventory(page,houses[0]!.name,true);
    await page.getByRole('button',{name:content.store,exact:true}).click();
    await saveEditing(page);
    expect((await readScene(page,sceneKeys[1])).placements).toEqual([]);
    await chooseScene(page,sceneKeys[2]);await expectScene(page,sceneKeys[2]);
    await page.getByRole('button',{name:content.edit,exact:true}).click();
    await chooseInventory(page,houses[0]!.name);
    await saveEditing(page);
    const lake=await readScene(page,sceneKeys[2]);
    expect(lake.placements.map(item=>item.instance_id)).toContain(placement.instance_id);
    expect((await readScene(page,sceneKeys[1])).placements).toEqual([]);
    expect((await readScene(page,sceneKeys[0])).placements).toEqual(original[0]!.placements);
    await waitHouse(page,lake);
    await captureScene(page,testInfo,'lakeside-transferred-house');
    await page.reload();await expectScene(page,sceneKeys[2]);
    expect(await page.evaluate(key=>localStorage.getItem(key),sceneContent.storageKey)).toBe(sceneKeys[2]);

    // 在浏览器执行正式导航代码，实际湖水与景物阻挡使用当前响应几何。
    const navigation=await page.evaluate(async state=>{
      const modulePath='/src/features/island/three/spatial-navigation.ts';
      const {createSpatialNavigation}=await import(modulePath);
      const nav=createSpatialNavigation(state);
      const water=state.scene.regions.find(region=>region.terrain==='water')!;
      const center={x_cm:water.polygon.reduce((sum,point)=>sum+point.x_cm,0)/water.polygon.length,z_cm:water.polygon.reduce((sum,point)=>sum+point.z_cm,0)/water.polygon.length};
      return {water:nav.walkable(center),fixed:(state.scene.fixed_objects??[]).filter(item=>item.walk_obstacle).map(item=>nav.walkable({x_cm:item.x_cm,z_cm:item.z_cm})),spawn:nav.walkable(nav.nearest(state.scene.spawn))};
    },lake);
    expect(navigation.water).toBe(false);expect(navigation.fixed.length).toBeGreaterThan(0);expect(navigation.fixed.every(value=>!value)).toBe(true);expect(navigation.spawn).toBe(true);
    expect(errors).toEqual([]);
  } finally {await restoreScenes(page,original);}
});

// 两个实际房型分别进入并检查四个方向；替换取消不能改变保存布局。
test('两栋房屋真实进出与四向剖墙，替换草稿可取消再保存',async({page},testInfo)=>{
  test.setTimeout(210_000);
  const houses=await prepareScenes(page),errors=renderErrors(page);
  const original=await Promise.all(sceneKeys.map(key=>readScene(page,key)));
  const session=await shopAPI<components['schemas']['SessionResponse']>(page,'/session');
  const preferences=session.account.preferences;
  try {
    // 实际行走需要明确的动效前提；其他流程可合法保留减少动效的账户偏好。
    await page.emulateMedia({reducedMotion:'no-preference'});
    await shopAPI(page,'/account/preferences','PATCH',{...preferences,reduce_motion:false});
    for(const key of sceneKeys.slice(1))await saveScene(page,await readScene(page,key),[]);
    await openScenes(page);await chooseScene(page,sceneKeys[1]);await expectScene(page,sceneKeys[1]);
    let previous:SpatialState|null=null;
    for(const [index,definition] of houses.entries()) {
      await page.getByRole('button',{name:content.edit,exact:true}).click();
      await chooseInventory(page,definition.name);
      if(previous) {
        expect((await readScene(page,sceneKeys[1])).placements).toEqual(previous.placements);
        await page.getByRole('button',{name:content.cancel,exact:true}).click();
        expect((await readScene(page,sceneKeys[1])).scene.house?.house_key).toBe(houseKeys[0]);
        await page.getByRole('button',{name:content.edit,exact:true}).click();
        await chooseInventory(page,definition.name);
      }
      await saveEditing(page);
      const saved=await readScene(page,sceneKeys[1]);
      expect(saved.scene.house?.house_key).toBe(houseKeys[index]);
      if(previous)expect(saved.scene.house?.interior).not.toEqual(previous.scene.house?.interior);
      await waitHouse(page,saved);
      await captureScene(page,testInfo,`house-${index}-exterior`);
      await page.getByRole('button',{name:content.enter,exact:true}).click();
      await expect(page.getByRole('button',{name:content.exit,exact:true})).toBeVisible({timeout:40_000});
      const stage=page.getByRole('region',{name:content.scene,exact:true});
      await expect(stage).toHaveAttribute('data-actor-space','indoor');
      await page.getByRole('button',{name:content.pause,exact:true}).click();
      const show=page.getByRole('button',{name:content.showCamera,exact:true});if(await show.isVisible())await show.click();
      const camera=page.getByRole('navigation',{name:content.camera,exact:true});
      for(let direction=0;direction<4;direction++) {
        await expect(stage).toHaveAttribute('data-camera-direction',String(direction));
        await captureScene(page,testInfo,`house-${index}-interior-${direction}`);
        await camera.getByRole('button',{name:content.cameraRight,exact:true}).click();
      }
      await page.getByRole('button',{name:content.resume,exact:true}).click();
      await page.getByRole('button',{name:content.exit,exact:true}).click();
      await expect(stage).toHaveAttribute('data-actor-space','outdoor',{timeout:40_000});
      previous=saved;
    }
    expect(errors).toEqual([]);
  } finally {
    try {await restoreScenes(page,original);}
    finally {await shopAPI(page,'/account/preferences','PATCH',preferences);}
  }
});

// 已提交响应丢失时，核对原场景后才能继续前往；普通未保存草稿可继续编辑。
test('切场景保留未保存草稿，保存结果未知时核对原场景再离开',async({page},testInfo)=>{
  test.setTimeout(150_000);
  const houses=await prepareScenes(page),errors=renderErrors(page);
  const original=await Promise.all(sceneKeys.map(key=>readScene(page,key)));
  const pattern='**/api/v1/island/layout';
  try {
    for(const key of sceneKeys.slice(1))await saveScene(page,await readScene(page,key),[]);
    await openScenes(page);await chooseScene(page,sceneKeys[1]);await expectScene(page,sceneKeys[1]);
    await page.getByRole('button',{name:content.edit,exact:true}).click();await chooseInventory(page,houses[0]!.name);await saveEditing(page);
    const before=await readScene(page,sceneKeys[1]),lakeBefore=await readScene(page,sceneKeys[2]);
    await page.getByRole('button',{name:content.edit,exact:true}).click();await chooseInventory(page,houses[0]!.name,true);
    await page.getByRole('button',{name:content.moveRight,exact:true}).click();
    await chooseScene(page,sceneKeys[2]);
    let leaving=page.getByRole('dialog',{name:content.leaveTitle,exact:true});
    await leaving.getByRole('button',{name:content.stay,exact:true}).click();
    expect((await readScene(page,sceneKeys[1])).version).toBe(before.version);
    await expect(page.getByRole('button',{name:content.save,exact:true})).toBeEnabled();
    let writes=0;
    await page.route(pattern,async route=>{
      if(route.request().method()!=='PUT'){await route.continue();return;}
      const input=route.request().postDataJSON() as components['schemas']['SpatialIslandSave'];
      expect(input.scene_key).toBe(sceneKeys[1]);writes++;
      const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort('failed');
    });
    await chooseScene(page,sceneKeys[2]);
    leaving=page.getByRole('dialog',{name:content.leaveTitle,exact:true});
    await leaving.getByRole('button',{name:content.saveLeave,exact:true}).click();
    await expect(leaving.getByText(content.unknownSave,{exact:true})).toBeVisible();
    await expect(leaving.getByRole('button',{name:content.discardLeave,exact:true})).toHaveCount(0);
    const committed=await readScene(page,sceneKeys[1]);expect(committed.version).toBe(before.version+1);
    expect(committed.placements[0]!.x_cm).toBe(before.placements[0]!.x_cm+10);
    expect((await readScene(page,sceneKeys[2])).version).toBe(lakeBefore.version);
    await leaving.getByRole('button',{name:content.readResult,exact:true}).click();
    await leaving.getByRole('button',{name:content.continueLeave,exact:true}).click();
    await expectScene(page,sceneKeys[2]);
    expect((await readScene(page,sceneKeys[1])).version).toBe(before.version+1);expect(writes).toBe(1);
    await captureScene(page,testInfo,'unknown-save-recovered-other-scene');
    expect(errors).toEqual([]);
  } finally {await page.unroute(pattern);await restoreScenes(page,original);}
});
