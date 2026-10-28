import test from 'node:test';
import assert from 'node:assert/strict';
import { todayKey, dateShift, weekDays, monthDays, rangeFor, eligibleTasks, summarize, addRecord, deleteRecord, editRecord, purchase } from '../src/domain.mjs';

const today = '2026-10-28';
// 构造每次独立的示例状态，避免测试之间共享修改。
function state() {
  return {
    tasks: [{ id: 'read', name: '阅读', icon: 'book', coins: 10, gems: 2, weekdays: [0, 1, 2, 3, 4, 5, 6], limit: 1 }],
    records: [], wallet: { coins: 20, gems: 5 },
    products: [{ id: 'hat', name: '探险帽', type: 'accessory', icon: 'hat', coins: 15, gems: 3, stock: 1, asset: 'hat.svg' }],
    owned: [],
  };
}

test('固定台北日期、跨月与跨年偏移', () => {
  assert.equal(todayKey(new Date('2026-10-27T16:00:00Z')), today);
  assert.equal(todayKey(new Date('2026-10-27T15:59:59Z')), '2026-10-27');
  assert.equal(dateShift('2026-01-01', -1), '2025-12-31');
  assert.equal(dateShift('2024-02-28', 1), '2024-02-29');
});

test('周从周一开始，月天数与日期范围准确', () => {
  assert.deepEqual(weekDays('2026-11-01'), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(monthDays('2024-02').length, 29);
  assert.equal(monthDays('2026-02').length, 28);
  assert.deepEqual(rangeFor('week', today), { start: '2026-10-26', end: today });
  assert.deepEqual(rangeFor('month', today), { start: '2026-10-01', end: today });
  assert.deepEqual(rangeFor('7', today), { start: '2026-10-22', end: today });
  assert.deepEqual(rangeFor('30', today), { start: '2026-09-29', end: today });
});

test('可打卡列表按星期、启用状态和当日次数过滤', () => {
  const initial = state();
  const tasks = [...initial.tasks, { ...initial.tasks[0], id: 'off', active: false }, { ...initial.tasks[0], id: 'weekend', weekdays: [0, 6] }];
  assert.deepEqual(eligibleTasks(tasks, [], today).map(task => task.id), ['read']);
  assert.deepEqual(eligibleTasks(tasks, [{ taskId: 'read', date: today }], today), []);
});

test('打卡保存奖励快照并发奖，原状态不变', () => {
  const initial = state();
  const next = addRecord(initial, 'read', { date: today, text: '读完一本书', audio: true }, { today });
  assert.equal(initial.records.length, 0);
  assert.deepEqual(initial.wallet, { coins: 20, gems: 5 });
  assert.deepEqual(next.wallet, { coins: 30, gems: 7 });
  assert.equal(next.records[0].name, '阅读');
  assert.equal(next.records[0].coins, 10);
  assert.equal(next.records[0].text, '读完一本书');
  assert.ok(next.records[0].id);
  assert.match(next.records[0].time, /^\d{2}:\d{2}$/);
});

test('普通用户仅今天，管理可补过去但不能未来，双方遵守次数和星期', () => {
  assert.throws(() => addRecord(state(), 'read', { date: '2026-10-27' }, { today }), /TODAY_ONLY/);
  assert.throws(() => addRecord(state(), 'read', { date: '2026-10-29' }, { today, admin: true }), /FUTURE_DATE/);
  assert.equal(addRecord(state(), 'read', { date: '2026-10-27' }, { today, admin: true }).records.length, 1);
  const once = addRecord(state(), 'read', { date: today }, { today });
  assert.throws(() => addRecord(once, 'read', { date: today }, { today, admin: true }), /LIMIT_REACHED/);
  const unavailable = state(); unavailable.tasks[0].weekdays = [0];
  assert.throws(() => addRecord(unavailable, 'read', { date: today }, { today, admin: true }), /TASK_UNAVAILABLE/);
  assert.throws(() => addRecord(state(), 'missing', { date: today }, { today }), /NOT_FOUND/);
});

test('编辑只修改附件内容，不重复发奖也不改变日期和奖励', () => {
  const initial = addRecord(state(), 'read', { date: today }, { today });
  const next = editRecord(initial, initial.records[0].id, { text: '新文字', audio: true, coins: 100, date: '2020-01-01' }, { today });
  assert.deepEqual(next.wallet, initial.wallet);
  assert.equal(next.records[0].text, '新文字');
  assert.equal(next.records[0].coins, 10);
  assert.equal(next.records[0].date, today);
  assert.equal(initial.records[0].text, '');
  assert.throws(() => editRecord(initial, initial.records[0].id, {}, { today: '2026-10-29' }), /TODAY_ONLY/);
  assert.equal(editRecord(initial, initial.records[0].id, { audio: false }, { today: '2026-10-29', admin: true }).records[0].audio, false);
});

test('删除按原奖励回收，允许负数余额，释放次数', () => {
  const initial = addRecord(state(), 'read', { date: today }, { today });
  initial.wallet = { coins: 0, gems: 0 };
  initial.tasks[0].coins = 99;
  const next = deleteRecord(initial, initial.records[0].id, { today });
  assert.deepEqual(next.wallet, { coins: -10, gems: -2 });
  assert.equal(next.records.length, 0);
  assert.equal(eligibleTasks(next.tasks, next.records, today).length, 1);
  assert.equal(initial.records.length, 1);
  assert.throws(() => deleteRecord(initial, initial.records[0].id, { today: '2026-10-29' }), /TODAY_ONLY/);
  assert.equal(deleteRecord(initial, initial.records[0].id, { today: '2026-10-29', admin: true }).records.length, 0);
});

test('统计按稳定项目标识累计有效记录，边界日期包含且忽略范围外数据', () => {
  const rows = [
    { taskId: 'read', name: '阅读', icon: 'book', date: '2026-10-01', coins: 10, gems: 1 },
    { taskId: 'read', name: '读书', icon: 'book', date: today, coins: 12, gems: 1 },
    { taskId: 'run', name: '跑步', icon: 'run', date: today, coins: 5, gems: 0 },
    { taskId: 'run', name: '跑步', icon: 'run', date: '2026-09-30', coins: 50, gems: 5 },
  ];
  const result = summarize(rows, '2026-10-01', today);
  assert.deepEqual({ total: result.total, days: result.days, coins: result.coins, gems: result.gems }, { total: 3, days: 2, coins: 27, gems: 2 });
  assert.deepEqual(result.items.map(({ taskId, count }) => ({ taskId, count })), [{ taskId: 'read', count: 2 }, { taskId: 'run', count: 1 }]);
  assert.deepEqual(summarize([], today, today), { total: 0, days: 0, coins: 0, gems: 0, items: [] });
});

test('购买同时扣两种货币和库存，保存所有物快照，原状态不变', () => {
  const initial = state();
  const next = purchase(initial, 'hat');
  assert.deepEqual(next.wallet, { coins: 5, gems: 2 });
  assert.equal(next.products[0].stock, 0);
  assert.equal(next.owned[0].status, 'owned');
  assert.equal(next.owned[0].asset, 'hat.svg');
  assert.equal(initial.products[0].stock, 1);
  assert.equal(initial.owned.length, 0);
});

test('购买拒绝不足余额、售罄、重复装扮和不存在商品', () => {
  const poor = state(); poor.wallet.gems = 2;
  assert.throws(() => purchase(poor, 'hat'), /INSUFFICIENT_BALANCE/);
  poor.wallet = { coins: -1, gems: 20 };
  assert.throws(() => purchase(poor, 'hat'), /INSUFFICIENT_BALANCE/);
  const sold = state(); sold.products[0].stock = 0;
  assert.throws(() => purchase(sold, 'hat'), /SOLD_OUT/);
  const owned = state(); owned.owned.push({ productId: 'hat' });
  assert.throws(() => purchase(owned, 'hat'), /ALREADY_OWNED/);
  assert.throws(() => purchase(state(), 'missing'), /NOT_FOUND/);
});

test('文本奖励可重复购买，不限库存，进入待兑现状态', () => {
  const initial = state(); initial.products[0] = { ...initial.products[0], type: 'reward', coins: 1, gems: 0, stock: null };
  const next = purchase(purchase(initial, 'hat'), 'hat');
  assert.equal(next.owned.length, 2);
  assert.equal(next.owned[0].status, 'pending');
  assert.equal(next.products[0].stock, null);
});
