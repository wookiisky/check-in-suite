import { copy as c } from '../config/content.mjs';
import { eligibleTasks, weekDays } from './domain.mjs';
import { icon } from './icons.mjs';
import { esc, dateLabel, weekdayLabel, rewards } from './ui-format.mjs';

// 完成记录只显示识别和回顾所需的信息，正文留在详情弹窗中。
function recordCard(record, tasks, weekly = false) {
  const color = tasks.find(task => task.id === record.taskId)?.color || 'green';
  const titleTag = weekly ? 'h4' : 'h3';
  return `<button type="button" class="${weekly ? 'week-record' : 'record-row'}" data-action="record-detail" data-id="${esc(record.id)}">
    <span class="task-icon ${esc(color)}">${icon(record.icon)}</span>
    <${titleTag} class="record-title">${esc(record.name)}</${titleTag}>
    <time class="record-time" datetime="${record.date}T${record.time}">${record.time}</time>
  </button>`;
}

// 日期详情与日视图共用同一大字记录列表。
export function renderRecordList(records, tasks) {
  if (!records.length) return `<div class="empty-state">${icon('leaf')}<h3>${c.noRecords}</h3></div>`;
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
  return `<div class="record-list">${sorted.map(record => recordCard(record, tasks)).join('')}</div>`;
}

// 日视图只处理所选日期，不附带一周日期选择条。
export function renderDayRecords(records, tasks, date) {
  return renderRecordList(records.filter(record => record.date === date), tasks);
}

// 七天记录同时输出，空白天与未来天也保留；窄屏由 CSS 改为逐日纵向分组。
export function renderWeekBoard(records, tasks, selectedDate, today) {
  return `<div class="week-board">${weekDays(selectedDate).map(date => {
    const dayRecords = records.filter(record => record.date === date).sort((a, b) => a.time.localeCompare(b.time));
    return `<section class="week-day${date === today ? ' is-today' : ''}${date > today ? ' is-future' : ''}" data-date="${date}">
      <header class="week-day-heading"><h3>${weekdayLabel(date)}</h3><time datetime="${date}">${dateLabel(date)}</time>${date === today ? `<span class="today-marker">${c.today}</span>` : ''}</header>
      <div class="week-records">${dayRecords.map(record => recordCard(record, tasks, true)).join('') || `<p class="week-empty">${date > today ? c.weekFuture : c.weekEmpty}</p>`}</div>
    </section>`;
  }).join('')}</div>`;
}

// 可操作卡片直接采用领域规则过滤，完成上限隐藏，删除记录后自动恢复。
export function renderAvailableTasks(tasks, records, date, category) {
  const available = eligibleTasks(tasks, records, date).filter(task => category === 'all' || task.categoryId === category);
  if (!available.length) {
    const scheduled = eligibleTasks(tasks, [], date).some(task => category === 'all' || task.categoryId === category);
    const label = scheduled ? (category === 'all' ? c.allTasksComplete : c.categoryComplete) : (category === 'all' ? c.noScheduledTasks : c.noTasks);
    return `<div class="empty-state tasks-empty" data-state="${scheduled ? 'complete' : 'unavailable'}">${icon(scheduled ? 'star' : 'calendar')}<h3>${label}</h3></div>`;
  }
  return `<div class="task-grid">${available.map(task => `<button type="button" class="task-card ${esc(task.color || 'green')}" data-action="checkin" data-id="${esc(task.id)}">
    <span class="task-icon ${esc(task.color || 'green')}">${icon(task.icon)}</span>
    <h3>${esc(task.name)}</h3>
    ${rewards(task.coins, task.gems, true)}
  </button>`).join('')}</div>`;
}
