import { expect, test, type Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';

type Camp = components['schemas']['CampResponse'];
type Records = components['schemas']['CheckinList'];
type Categories = components['schemas']['CategoryList'];

// 所有变更经管理页面提交，API只读取数据库中的结果。
async function readJSON<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api/v1${path}`);
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<T>;
}

// 登录与解锁沿用公开页面入口，不借用测试专用权限。
async function enterManagement(page: Page) {
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
  await page.getByRole('button', { name: content.navigation.tasks, exact: true }).click();
}

// 日期只由服务端的台北业务日推导，避免依赖运行机器的时区。
function offsetDate(today: string, days: number) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// 精确匹配配置名称，避免类别和任务的相似文案命中其他行。
function configurationRow(page: Page, name: string) {
  return page.locator('.checkin-config-row').filter({ has: page.getByText(name, { exact: true }) });
}

// 多个管理流程都需要通过表单建立自己的任务，彼此不复用业务数据。
async function createTask(page: Page, name: string, category?: string) {
  await page.getByRole('button', { name: checkin.newTask, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(checkin.name, { exact: true }).fill(name);
  if (category) await dialog.getByRole('combobox', { name: checkin.category, exact: true }).selectOption({ label: category });
  await dialog.getByLabel(checkin.coins, { exact: true }).fill('11');
  await dialog.getByLabel(checkin.diamonds, { exact: true }).fill('2');
  await dialog.getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const tasks = await readJSON<components['schemas']['TaskList']>(page, '/tasks?include_inactive=true');
  const task = tasks.items.find((item) => item.name === name);
  expect(task).toBeDefined();
  return task!;
}

// 配置编辑、停启与删除均由真实页面完成，并核对历史与钱包不会被隐式改写。
test('管理类别和任务的新增、编辑、排序、停启及引用删除约束', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const categoryName = `类别-${suffix}`;
  const renamedCategory = `改类-${suffix}`;
  const taskName = `项目-${suffix}`;
  const renamedTask = `改项-${suffix}`;
  await enterManagement(page);

  await page.getByRole('button', { name: checkin.newCategory, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await dialog.getByLabel(checkin.name, { exact: true }).evaluate((element) => (element as HTMLInputElement).validity.valueMissing)).toBe(true);
  await dialog.getByLabel(checkin.name, { exact: true }).fill(categoryName);
  await dialog.getByLabel(checkin.sortOrder, { exact: true }).fill('25');
  await dialog.getByRole('button', { name: checkin.close, exact: true }).click();
  await expect(dialog.getByText(checkin.discardQuestion)).toBeVisible();
  await dialog.getByRole('button', { name: checkin.keepEditing, exact: true }).click();
  await expect(dialog.getByLabel(checkin.name, { exact: true })).toHaveValue(categoryName);
  await dialog.getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await configurationRow(page, categoryName).getByRole('button', { name: checkin.editConfig, exact: true }).click();
  await dialog.getByLabel(checkin.name, { exact: true }).fill(renamedCategory);
  await dialog.getByLabel(checkin.sortOrder, { exact: true }).fill('-200');
  await dialog.getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(dialog.getByRole('alert').first()).toBeVisible();
  await expect(dialog.getByLabel(checkin.name, { exact: true })).toHaveValue(renamedCategory);
  await dialog.getByLabel(checkin.sortOrder, { exact: true }).fill('7');
  await dialog.getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const categories = await readJSON<Categories>(page, '/categories');
  const category = categories.items.find((item) => item.name === renamedCategory)!;
  expect(category).toMatchObject({ name: renamedCategory, sort_order: 7 });
  const positions = categories.items.map((item) => item.sort_order);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
  const task = await createTask(page, taskName, renamedCategory);
  expect(task.category_id).toBe(category.id);

  await configurationRow(page, renamedCategory).getByRole('button', { name: checkin.remove, exact: true }).click();
  await dialog.getByRole('button', { name: checkin.remove, exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(checkin.errors.CATEGORY_NOT_EMPTY);
  await dialog.getByRole('button', { name: checkin.cancel, exact: true }).click();
  await page.getByRole('button', { name: checkin.reload, exact: true }).click();
  await expect(configurationRow(page, taskName).getByRole('button', { name: checkin.editConfig, exact: true })).toBeEnabled();

  await configurationRow(page, taskName).getByRole('button', { name: checkin.editConfig, exact: true }).click();
  await dialog.getByLabel(checkin.name, { exact: true }).fill(renamedTask);
  await dialog.getByRole('combobox', { name: checkin.category, exact: true }).selectOption('');
  await dialog.getByLabel(checkin.coins, { exact: true }).fill('-1');
  await dialog.getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await dialog.getByLabel(checkin.coins, { exact: true }).evaluate((element) => (element as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
  await dialog.getByLabel(checkin.coins, { exact: true }).fill('13');
  await dialog.getByLabel(checkin.diamonds, { exact: true }).fill('4');
  await dialog.getByLabel(checkin.dailyLimit, { exact: true }).fill('2');
  await dialog.getByRole('combobox', { name: checkin.icon, exact: true }).selectOption('star-v1');
  for (const weekday of checkin.weekdays) await dialog.getByRole('checkbox', { name: weekday, exact: true }).uncheck();
  await expect(dialog.getByRole('alert')).toHaveText(checkin.weekdayRequired);
  await expect(dialog.getByRole('button', { name: checkin.save, exact: true })).toBeDisabled();
  const initial = await readJSON<Camp>(page, '/camp');
  const excludedWeekday = new Date(`${offsetDate(initial.today, 2)}T00:00:00Z`).getUTCDay() || 7;
  for (let day = 1; day <= 7; day++) {
    if (day !== excludedWeekday) await dialog.getByRole('checkbox', { name: checkin.weekdays[day - 1]!, exact: true }).check();
  }
  for (const activity of ['read', 'run', 'ball'] as const) await dialog.getByRole('checkbox', { name: checkin.activityLabels[activity], exact: true }).check();
  await dialog.getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const configured = (await readJSON<components['schemas']['TaskList']>(page, '/tasks?include_inactive=true')).items.find((item) => item.id === task.id)!;
  expect(configured).toMatchObject({ name: renamedTask, category_id: null, icon_key: 'star-v1', coin_reward: 13, diamond_reward: 4, daily_limit: 2, enabled: true, unlock_activities: ['ball', 'read', 'run'] });
  expect(configured.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7].filter((day) => day !== excludedWeekday));

  await page.getByRole('button', { name: `${checkin.disableTask} ${renamedTask}`, exact: true }).click();
  await expect(configurationRow(page, renamedTask)).toHaveCount(0);
  await page.getByRole('checkbox', { name: checkin.showDisabledTasks, exact: true }).check();
  await page.getByRole('button', { name: `${checkin.enableTask} ${renamedTask}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${checkin.disableTask} ${renamedTask}`, exact: true })).toBeEnabled();

  const date = offsetDate(initial.today, -1);
  await page.getByRole('button', { name: content.navigation.records, exact: true }).click();
  await page.getByLabel(checkin.date, { exact: true }).fill(date);
  await page.getByRole('combobox', { name: checkin.chooseTask, exact: true }).selectOption(task.id);
  await page.getByRole('button', { name: checkin.backfillNew, exact: true }).click();
  await dialog.getByLabel(checkin.text).fill('任务删除后仍需保留的历史');
  await dialog.getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const granted = await readJSON<Camp>(page, '/camp');

  await page.getByRole('button', { name: content.navigation.tasks, exact: true }).click();
  await configurationRow(page, renamedTask).getByRole('button', { name: checkin.remove, exact: true }).click();
  await dialog.getByRole('button', { name: checkin.cancel, exact: true }).click();
  await expect(configurationRow(page, renamedTask)).toBeVisible();
  await configurationRow(page, renamedTask).getByRole('button', { name: checkin.remove, exact: true }).click();
  await dialog.getByRole('button', { name: checkin.remove, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(configurationRow(page, renamedTask)).toHaveCount(0);
  const history = await readJSON<Records>(page, `/checkins?start_date=${date}&end_date=${date}`);
  expect(history.items.filter((item) => item.task_id === task.id)).toMatchObject([{ task_name_snapshot: renamedTask, coin_reward_snapshot: 13, diamond_reward_snapshot: 4 }]);
  expect((await readJSON<Camp>(page, '/camp')).wallet).toEqual(granted.wallet);
  await configurationRow(page, renamedCategory).getByRole('button', { name: checkin.remove, exact: true }).click();
  await dialog.getByRole('button', { name: checkin.remove, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(configurationRow(page, renamedCategory)).toHaveCount(0);

  await page.getByRole('button', { name: content.navigation.records, exact: true }).click();
  await page.getByLabel(checkin.date, { exact: true }).fill(date);
  await page.locator('.checkin-record').filter({ hasText: renamedTask }).click();
  await dialog.getByRole('button', { name: checkin.delete, exact: true }).click();
  await dialog.getByRole('button', { name: checkin.confirmDelete, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const returned = (await readJSON<Camp>(page, '/camp')).wallet;
  expect(returned.coins).toBe(initial.wallet.coins);
  expect(returned.diamonds).toBe(initial.wallet.diamonds);
});

// 补录、编辑和纠正使用不同经济语义，分别核对实际记录和双币余额。
test('管理历史补录、错误恢复、内容编辑、纠正日期与删除回收', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const taskName = `历史-${testInfo.project.name}-${Date.now()}`;
  await enterManagement(page);
  const task = await createTask(page, taskName);
  const initial = await readJSON<Camp>(page, '/camp');
  const date = offsetDate(initial.today, -1);
  const correctedDate = offsetDate(initial.today, -2);
  const readRecords = async (businessDate: string) => (await readJSON<Records>(page, `/checkins?start_date=${businessDate}&end_date=${businessDate}`)).items.filter((item) => item.task_id === task.id);
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: content.navigation.records, exact: true }).click();
  await page.getByLabel(checkin.date, { exact: true }).fill(offsetDate(initial.today, 1));
  await page.getByRole('combobox', { name: checkin.chooseTask, exact: true }).selectOption(task.id);
  await page.getByRole('button', { name: checkin.backfillNew, exact: true }).click();
  await dialog.getByLabel(checkin.text).fill('未来日期的未提交草稿');
  await dialog.getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(checkin.errors.FUTURE_DATE);
  await expect(dialog.getByLabel(checkin.text)).toHaveValue('未来日期的未提交草稿');
  expect((await readJSON<Camp>(page, '/camp')).wallet).toEqual(initial.wallet);
  await dialog.getByRole('button', { name: checkin.close, exact: true }).click();
  await dialog.getByRole('button', { name: checkin.discard, exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByLabel(checkin.date, { exact: true }).fill(date);
  await page.getByRole('button', { name: checkin.backfillNew, exact: true }).click();
  await dialog.getByLabel(checkin.text).fill('原始历史内容');
  await dialog.getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await readRecords(date)).length).toBe(1);
  const original = (await readRecords(date))[0]!;
  expect(original).toMatchObject({ source: 'backfill', business_date: date, text: '原始历史内容', coin_reward_snapshot: 11, diamond_reward_snapshot: 2 });
  const granted = await readJSON<Camp>(page, '/camp');
  expect(granted.wallet.coins).toBe(initial.wallet.coins + 11);
  expect(granted.wallet.diamonds).toBe(initial.wallet.diamonds + 2);

  await page.getByRole('button', { name: checkin.backfillNew, exact: true }).click();
  await dialog.getByLabel(checkin.text).fill('次数超限时保留的草稿');
  await dialog.getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(checkin.errors.DAILY_LIMIT_REACHED);
  await expect(dialog.getByLabel(checkin.text)).toHaveValue('次数超限时保留的草稿');
  await dialog.getByRole('button', { name: checkin.close, exact: true }).click();
  await dialog.getByRole('button', { name: checkin.discard, exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.locator('.checkin-record').filter({ hasText: taskName }).click();
  await dialog.getByRole('button', { name: checkin.edit, exact: true }).click();
  await dialog.getByLabel(checkin.text).fill('历史内容修改，不重复发奖');
  await dialog.getByRole('button', { name: checkin.close, exact: true }).click();
  await expect(dialog.getByText(checkin.discardQuestion)).toBeVisible();
  await dialog.getByRole('button', { name: checkin.keepEditing, exact: true }).click();
  await expect(dialog.getByLabel(checkin.text)).toHaveValue('历史内容修改，不重复发奖');
  await dialog.getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await readRecords(date))[0]).toMatchObject({ id: original.id, text: '历史内容修改，不重复发奖', version: original.version + 1 });
  expect((await readJSON<Camp>(page, '/camp')).wallet).toEqual(granted.wallet);

  await page.locator('.checkin-record').filter({ hasText: taskName }).click();
  await dialog.getByRole('button', { name: checkin.delete, exact: true }).click();
  await expect(dialog.getByText('−11', { exact: true })).toBeVisible();
  await expect(dialog.getByText('−2', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: checkin.cancel, exact: true }).click();
  expect((await readRecords(date))[0]!.id).toBe(original.id);
  await dialog.getByRole('button', { name: checkin.correctRecord, exact: true }).click();
  await expect(dialog.getByText(checkin.correctWarning)).toBeVisible();
  await dialog.getByRole('button', { name: checkin.cancel, exact: true }).click();
  await dialog.getByRole('button', { name: checkin.correctRecord, exact: true }).click();
  await dialog.getByRole('button', { name: checkin.confirmCorrection, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(checkin.correctionDeleted, { exact: true })).toBeVisible();
  expect(await readRecords(date)).toEqual([]);
  const afterCorrection = (await readJSON<Camp>(page, '/camp')).wallet;
  expect(afterCorrection.coins).toBe(initial.wallet.coins);
  expect(afterCorrection.diamonds).toBe(initial.wallet.diamonds);

  await page.getByLabel(checkin.date, { exact: true }).fill(correctedDate);
  await page.getByRole('button', { name: checkin.backfillNew, exact: true }).click();
  await expect(dialog.getByLabel(checkin.text)).toHaveValue('历史内容修改，不重复发奖');
  await dialog.getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const corrected = (await readRecords(correctedDate))[0]!;
  expect(corrected.id).not.toBe(original.id);
  expect(corrected).toMatchObject({ task_id: task.id, business_date: correctedDate, text: '历史内容修改，不重复发奖' });
  const regranted = (await readJSON<Camp>(page, '/camp')).wallet;
  expect(regranted.coins).toBe(granted.wallet.coins);
  expect(regranted.diamonds).toBe(granted.wallet.diamonds);
  await page.locator('.checkin-record').filter({ hasText: taskName }).click();
  await dialog.getByRole('button', { name: checkin.delete, exact: true }).click();
  await dialog.getByRole('button', { name: checkin.confirmDelete, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await readRecords(correctedDate)).toEqual([]);
  const finalWallet = (await readJSON<Camp>(page, '/camp')).wallet;
  expect(finalWallet.coins).toBe(initial.wallet.coins);
  expect(finalWallet.diamonds).toBe(initial.wallet.diamonds);
  await page.getByRole('button', { name: content.navigation.tasks, exact: true }).click();
  await configurationRow(page, taskName).getByRole('button', { name: checkin.remove, exact: true }).click();
  await dialog.getByRole('button', { name: checkin.remove, exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
