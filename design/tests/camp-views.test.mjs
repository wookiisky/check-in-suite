import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, deleteRecord } from '../src/domain.mjs';
import { renderRecordList, renderDayRecords, renderWeekBoard, renderAvailableTasks } from '../src/camp-views.mjs';

const today = '2026-10-29';
const tasks = [
  { id: 'read', name: '读书', icon: 'book', categoryId: 'learn', description: '不应出现在任务卡的描述', coins: 10, gems: 1, limit: 1, weekdays: [0,1,2,3,4,5,6] },
  { id: 'piano', name: '练琴', icon: 'music', categoryId: 'learn', coins: 15, gems: 2, limit: 2, weekdays: [0,1,2,3,4,5,6] },
];

// 示例记录独立于生成器，覆盖跨周边界和同日多条记录。
function record(id, date, task = tasks[0]) {
  return { id, taskId: task.id, name: task.name, icon: task.icon, coins: task.coins, gems: task.gems, date, time: '09:30', text: '只在详情中查看的正文' };
}

test('日视图仅渲染所选一天的记录，不含七天切换条或正文摘要', () => {
  const html = renderDayRecords([record('today-record', today), record('yesterday-record','2026-10-28')], tasks, today);
  assert.match(html, /data-id="today-record"/);
  assert.doesNotMatch(html, /data-id="yesterday-record"|week-strip|week-board/);
  assert.doesNotMatch(html, /只在详情中查看的正文/);
  assert.match(html, /datetime="2026-10-29T09:30"/);
});

test('周视图直接渲染七个日期分组，保留空天且排除邻周记录', () => {
  const html = renderWeekBoard([
    record('sunday-before','2026-10-25'), record('monday','2026-10-26'),
    record('thursday-1',today), record('thursday-2',today,tasks[1]), record('monday-after','2026-11-02'),
  ], tasks, today, today);
  const dates = [...html.matchAll(/<section class="week-day[^\"]*" data-date="([^\"]+)"/g)].map(match => match[1]);
  assert.deepEqual(dates, ['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01']);
  assert.doesNotMatch(html, /data-id="sunday-before"|data-id="monday-after"/);
  assert.equal((html.match(/class="week-empty"/g) || []).length, 5);
  const thursday = html.split('data-date="2026-10-29"')[1].split('</section>')[0];
  assert.match(thursday, /data-id="thursday-1"/);
  assert.match(thursday, /data-id="thursday-2"/);
  assert.match(html, /is-today/);
});

test('达到次数上限后任务卡消失，删除记录释放次数后重新出现', () => {
  const initial = { tasks, records: [], wallet: { coins: 0, gems: 0 } };
  const completed = addRecord(initial,'read',{date:today},{today});
  assert.doesNotMatch(renderAvailableTasks(tasks,completed.records,today,'all'), /data-id="read"/);
  const restored = deleteRecord(completed,completed.records[0].id,{today});
  const html = renderAvailableTasks(tasks,restored.records,today,'all');
  assert.match(html, /<button[^>]*class="task-card[^>]*data-id="read"/);
  assert.doesNotMatch(html, /不应出现在任务卡的描述|task-description|countLimit|disabled/);
});

test('多次项目未满时保留，满额后移除，类别筛选不能绕过上限', () => {
  const one = [record('first',today,tasks[1])];
  assert.match(renderAvailableTasks(tasks,one,today,'learn'), /data-id="piano"/);
  assert.doesNotMatch(renderAvailableTasks(tasks,[...one,record('second',today,tasks[1])],today,'learn'), /data-id="piano"/);
  assert.doesNotMatch(renderAvailableTasks(tasks,[],today,'missing'), /data-action="checkin"/);
});

test('周记录保留历史名称，任务改名不改变过去展示', () => {
  const history = record('snapshot',today);
  const changed = [{...tasks[0],name:'新名称',coins:99}];
  const html = renderWeekBoard([history],changed,today,today);
  assert.match(html, /读书/);
  assert.doesNotMatch(html, /新名称|\+99/);
  assert.doesNotMatch(html, /reward-inline|class="currency/);
});

test('任务已全部完成与当天没有安排使用不同的空状态', () => {
  const done = [record('done',today)];
  assert.match(renderAvailableTasks([tasks[0]],done,today,'all'), /data-state="complete"/);
  assert.match(renderAvailableTasks([],[],today,'all'), /data-state="unavailable"/);
  assert.match(renderAvailableTasks(tasks,[],today,'missing'), /data-state="unavailable"/);
});

test('已完成记录在日、周及月历日期列表隐藏奖励，可打卡任务仍显示奖励', () => {
  const records = [record('done',today)];
  for (const html of [renderDayRecords(records,tasks,today), renderWeekBoard(records,tasks,today,today), renderRecordList(records,tasks)]) {
    assert.doesNotMatch(html, /reward-inline|class="currency/);
    assert.match(html, /09:30/);
  }
  assert.match(renderAvailableTasks(tasks,[],today,'all'), /reward-inline/);
});
