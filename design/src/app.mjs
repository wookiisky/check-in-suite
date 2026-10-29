import { copy as c } from '../config/content.mjs';
import { createSeed } from './seed.mjs';
import { icon } from './icons.mjs';
import { esc, t, dateLabel, monthLabel, weekdayLabel, rewards, currencyLabel } from './ui-format.mjs';
import { renderDayRecords, renderWeekBoard, renderAvailableTasks, renderRecordList } from './camp-views.mjs';
import { todayKey, dateShift, weekDays, monthDays, rangeFor, eligibleTasks, summarize, addRecord, editRecord, deleteRecord, purchase } from './domain.mjs';

const storageKey = 'growth-island-prototype-v1';
const app = document.querySelector('#app');
const header = document.querySelector('#header');
const modal = document.querySelector('#modal');
const today = todayKey();
let state;
try { state = JSON.parse(localStorage.getItem(storageKey)) || createSeed(); } catch { state = createSeed(); }
/** 界面状态不混入业务数据；管理解锁仅在当前页面访问期间有效。 */
const view = { page: 'camp', mode: 'day', date: today, month: today.slice(0, 7), category: 'all', shopTab: 'browse', productType: 'all', adminTab: 'account', adminDate: today, unlocked: false, logged: sessionStorage.getItem('island-logged') !== 'false', range: rangeFor('month', today), preset: 'month', music: false, sound: true, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches };
let dialogAction = null;
let dialogCleanup = null;
let dialogDirty = false;
let toastTimer;
let musicTimer;
let audioContext;

function button(action, label, symbol, className = 'secondary', extra = '') { return `<button type="button" class="${className}" data-action="${action}" ${extra}>${symbol ? icon(symbol) : ''}<span>${label}</span></button>`; }
function iconButton(action, label, symbol, extra = '') { return `<button type="button" class="icon-btn" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}>${icon(symbol)}</button>`; }
function empty(title, subtitle = '') { return `<div class="empty-state">${icon('leaf')}<h3>${title}</h3>${subtitle ? `<p>${subtitle}</p>` : ''}</div>`; }
function field(label, name, value = '', type = 'text', attrs = '') { return `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`; }
function selectField(label, name, options, value, attrs = '') { return `<label class="field"><span>${label}</span><select name="${name}" ${attrs}>${options.map(([id, title]) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(title)}</option>`).join('')}</select></label>`; }
function notify(message) { const element = document.querySelector('#toast'); element.textContent = message; element.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('visible'), 3600); }
function persist() { try { localStorage.setItem(storageKey, JSON.stringify(state)); return true; } catch { notify(c.prototypeStorage); return false; } }
function commit(next, message) { state = next; const saved = persist(); render(); if (saved && message) notify(message); }
function run(action) { try { action(); } catch (error) { notify(c.errors[error.code || error.message] || c.errors.UNKNOWN); } }

// 音乐由显式用户手势启动；短音符在页面隐藏或录音时暂停。
function tone(frequency = 660, duration = .18, volume = .05) {
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  audioContext.resume();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'sine'; oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
  oscillator.connect(gain); gain.connect(audioContext.destination);
  oscillator.start(); oscillator.stop(audioContext.currentTime + duration);
}
function updateMusic() {
  clearInterval(musicTimer);
  if (!view.music || document.hidden || (modal.open && modal.querySelector('[data-recording="true"]'))) return;
  let step = 0;
  musicTimer = setInterval(() => tone([523, 659, 784, 659, 587, 698, 880, 698][step++ % 8], .6, .018), 650);
}
function celebrate() {
  if (view.sound) { tone(659); setTimeout(() => tone(880), 120); }
  if (view.reduced) return;
  const layer = document.querySelector('#celebration');
  layer.innerHTML = Array.from({ length: 24 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--delay:${(i % 5) * .07}s;--rotation:${i * 43}deg;background:${['#eac85a','#77a881','#e6a190','#9caddb'][i % 4]}"></i>`).join('');
  setTimeout(() => { layer.innerHTML = ''; }, 2200);
}

// 原生 dialog 提供焦点限制和 Escape；未保存内容离开前确认。
function openDialog(title, body, footer = '', action = null, cleanup = null) {
  dialogCleanup?.(); dialogCleanup = cleanup; dialogAction = action; dialogDirty = false;
  modal.innerHTML = `<div class="modal-header"><h2>${title}</h2>${iconButton('close-modal', c.close, 'close')}</div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}`;
  modal.setAttribute('aria-label', title.replace(/<[^>]+>/g, ''));
  if (!modal.open) modal.showModal();
}
function closeDialog(force = false) {
  if (!force && dialogDirty && !window.confirm(c.discardBody)) return;
  dialogCleanup?.(); dialogCleanup = null; dialogDirty = false; modal.close(); dialogAction = null; updateMusic();
}
function confirmation(title, body, action, label = c.confirm, danger = false) {
  openDialog(title, body, button('close-modal', c.cancel, null, 'secondary') + button('confirm-dialog', label, null, danger ? 'danger' : 'primary'), key => { if (key === 'confirm-dialog') { closeDialog(true); run(action); } });
}
modal.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
modal.addEventListener('input', () => { dialogDirty = true; });

// 顶部导航保持页面间的位置和名称一致。
function renderHeader() {
  header.hidden = !view.logged;
  if (!view.logged) return;
  header.innerHTML = `<div class="header-inner"><a class="brand" href="#camp" data-action="navigate" data-page="camp"><span class="brand-mark">${icon('leaf')}</span><span class="brand-copy"><strong>${c.brand}</strong></span></a><nav class="main-nav" aria-label="${c.brand}">${[['camp','home'],['calendar','calendar'],['stats','chart'],['shop','shop']].map(([page, symbol]) => button('navigate', c[page], symbol, `nav-btn ${view.page === page ? 'active' : ''}`, `data-page="${page}" ${view.page === page ? 'aria-current="page"' : ''}`)).join('')}</nav><div class="header-tools">${iconButton('music', view.music ? c.musicOn : c.musicOff, view.music ? 'music' : 'mute', `aria-pressed="${view.music}"`)}${iconButton('sound', view.sound ? c.soundOn : c.soundOff, 'sound', `aria-pressed="${view.sound}"`)}<button class="user-chip" data-action="logout" title="${c.logout}">${icon('user')}<span>${esc(state.profile.name)}</span>${icon('logout')}</button></div></div>`;
}
function render() {
  const messageInput = app.querySelector('[name="message"]');
  if (messageInput) view.messageDraft = messageInput.value;
  renderHeader(); document.body.classList.toggle('reduced-motion', view.reduced);
  if (!view.logged) { app.innerHTML = loginView(); return; }
  app.innerHTML = ({ camp: campView, calendar: calendarView, stats: statsView, shop: shopView, admin: adminView }[view.page] || campView)();
  app.insertAdjacentHTML('beforeend', `<footer class="prototype-note"><details><summary>${c.prototypeShort}</summary><p>${c.prototype}</p><div>${button('motion', view.reduced ? c.restoreMotion : c.reduceMotion, null, 'ghost')}${button('reset', c.reset, null, 'ghost')}</div></details></footer>`);
}
// 页面标题只保留当前任务，避免重复口号占据主要区域。
function pageHeading(title) {
  return `<div class="page-heading"><h1>${title}</h1>${button('navigate', c.backCamp, 'left', 'secondary', 'data-page="camp"')}</div>`;
}

// 日期详情共用精简的完成记录列表。
function recordRows(records) { return renderRecordList(records, state.tasks); }

// 主营地将记录查看与今天的可操作任务分开，查看历史不会改变打卡日期。
function campView() {
  const completed = state.records.filter(record => record.date === today).length;
  const days = weekDays(view.date);
  const weekly = view.mode === 'week';
  return `<div class="dashboard-grid ${weekly ? 'week-mode' : ''}">
    <div class="main-column">
      <section class="hero">
        <div class="hero-copy"><h1>${t('hello', { name: state.profile.name })}</h1><span class="pill">${icon('check')}${t('todayCompleted', { count: completed })}</span></div>
      </section>
      <section class="panel record-panel">
        <div class="section-heading"><h2>${c.recordHeading}</h2><div class="segmented">${['day','week'].map(mode => button('view-mode', c[mode], null, mode === view.mode ? 'active' : '', `data-mode="${mode}" aria-pressed="${mode === view.mode}"`)).join('')}</div></div>
        <div class="date-navigation">
          ${iconButton('shift-date', weekly ? c.previousWeek : c.previousDay, 'left', 'data-step="-1"')}
          <strong>${weekly ? `${dateLabel(days[0])} — ${dateLabel(days[6])}` : dateLabel(view.date, true)}</strong>
          ${iconButton('shift-date', weekly ? c.nextWeek : c.nextDay, 'right', 'data-step="1"')}
          ${button('today', weekly ? c.thisWeek : c.today, null, 'secondary')}
        </div>
        ${weekly ? renderWeekBoard(state.records, state.tasks, view.date, today) : renderDayRecords(state.records, state.tasks, view.date)}
      </section>
      <section class="tasks-section">
        <div class="section-heading"><h2>${c.taskHeading}</h2><span class="date-tag">${dateLabel(today)}</span></div>
        <div class="category-tabs">${[{ id: 'all', name: c.all }, ...state.categories].map(category => button('category', esc(category.name), null, category.id === view.category ? 'active' : '', `data-id="${category.id}" aria-pressed="${category.id === view.category}"`)).join('')}</div>
        ${renderAvailableTasks(state.tasks, state.records, today, view.category)}
      </section>
    </div>
    ${sidebarView()}
  </div>`;
}
function sidebarView() {
  const avatar = state.owned.find(item => item.id === state.equipped.avatar);
  const title = state.owned.find(item => item.id === state.equipped.title);
  const accessory = state.owned.find(item => item.id === state.equipped.accessory);
  return `<aside class="sidebar"><section class="panel character-panel"><div class="wallet"><div><strong class="currency coin">${currencyLabel('coin')}${state.wallet.coins}</strong></div><div><strong class="currency gem">${currencyLabel('gem')}${state.wallet.gems}</strong></div></div>${state.wallet.coins < 0 || state.wallet.gems < 0 ? `<p class="warning">${c.negative}</p>` : ''}<p class="character-name">${t('character', { name: state.profile.name })}</p><div class="character-stage"><span class="stage-spark spark-one">✦</span><img src="${esc(avatar?.asset || 'assets/bunny.svg')}" alt="${esc(avatar?.name || c.defaultPet)}">${accessory ? `<span class="equipped-accessory" title="${esc(accessory.name)}">${icon(accessory.icon)}</span>` : ''}<span class="stage-spark spark-two">✧</span></div><h2>${esc(avatar?.name || c.defaultPet)}</h2><span class="badge">${icon('crown')}${esc(title?.name || c.defaultTitle)}</span>${button('navigate', c.shopCta, 'shop', 'shop-button', 'data-page="shop"')}</section><section class="panel message-panel"><div class="section-heading"><h2>${icon('message')}${c.board}</h2></div><div class="message-list">${state.messages.map(message => `<article class="message-note"><p>${esc(message.text)}</p><div class="note-meta"><time datetime="${message.date}">${dateLabel(message.date)}</time>${iconButton('delete-message', c.deleteMessage, 'trash', `data-id="${message.id}"`)}</div></article>`).join('') || `<p class="muted">${c.emptyMessages}</p>`}</div><form class="message-form" data-form="message"><label class="sr-only" for="message">${c.messagePlaceholder}</label><input id="message" name="message" placeholder="${c.messagePlaceholder}" value="${esc(view.messageDraft || '')}" maxlength="300" required><button class="icon-btn" aria-label="${c.send}">${icon('arrow')}</button></form></section><button class="settings-button" data-action="admin">${icon('settings')}<span><strong>${c.settings}</strong></span>${icon('right')}</button></aside>`;
}

function calendarView() {
  const dates = monthDays(view.month);
  const padding = (new Date(`${dates[0]}T12:00:00`).getDay() + 6) % 7;
  const summary = summarize(state.records, dates[0], dates.at(-1));
  return `${pageHeading(c.calendarTitle, c.calendarSub)}<div class="calendar-layout"><section class="panel calendar-panel"><div class="section-heading"><div class="date-navigation">${iconButton('shift-month', c.prevMonth, 'left', 'data-step="-1"')}<h2>${monthLabel(view.month)}</h2>${iconButton('shift-month', c.nextMonth, 'right', 'data-step="1"')}${button('this-month',c.thisMonth,null,'ghost')}</div><span class="pill">${t('monthCount', { count: summary.total })}</span></div><div class="calendar-weekdays">${weekDays(today).map(date => `<span>${weekdayLabel(date)}</span>`).join('')}</div><div class="calendar-grid">${'<div class="calendar-cell empty"></div>'.repeat(padding)}${dates.map(date => {
    const records = state.records.filter(record => record.date === date);
    return `<button class="calendar-cell ${date === today ? 'today' : ''} ${date === view.date ? 'selected' : ''}" data-action="calendar-date" data-date="${date}" aria-pressed="${date === view.date}" aria-label="${dateLabel(date, true)} ${t('times', { count: records.length })}"><span class="calendar-number">${Number(date.slice(-2))}${date === today ? `<small>${c.today}</small>` : ''}</span>${records.length ? `<span class="calendar-icons">${records.slice(0,3).map(record => icon(record.icon)).join('')}</span><span class="calendar-count">${t('times', { count: records.length })}</span>` : '<span class="calendar-blank">·</span>'}</button>`;
  }).join('')}</div></section><aside class="panel day-detail"><p class="eyebrow">${c.dateDetail}</p><h2>${dateLabel(view.date, true)}</h2>${view.date > today ? empty(c.future) : recordRows(state.records.filter(record => record.date === view.date))}${view.date < today ? `<p class="muted">${c.readonly}</p>` : ''}</aside></div>`;
}
function statsView() {
  const summary = summarize(state.records, view.range.start, view.range.end);
  const maximum = Math.max(...summary.items.map(item => item.count), 1);
  return `${pageHeading(t('statsTitle', { name: state.profile.name }), c.statsSub)}<section class="panel filters"><div class="category-tabs">${[['week','weekRange'],['month','monthRange'],['7','sevenRange'],['30','thirtyRange'],['custom','customRange']].map(([preset,label]) => button('range', c[label], null, view.preset === preset ? 'active' : '', `data-preset="${preset}" aria-pressed="${view.preset === preset}"`)).join('')}</div><form class="range-form" data-form="range">${field(c.startDate,'start',view.range.start,'date','required')}${field(c.endDate,'end',view.range.end,'date',`required max="${today}"`)}<button class="secondary">${c.apply}</button></form></section><div class="stats-summary">${[['totalChecks',summary.total,'check','green'],['totalDays',summary.days,'calendar','peach'],['totalCoins',summary.coins,'coin','yellow'],['totalGems',summary.gems,'gem','purple']].map(([label,value,symbol,color]) => `<article class="stat-card${symbol === 'coin' || symbol === 'gem' ? ' stat-card-currency' : ''}"><span class="task-icon ${color}">${icon(symbol)}</span><span${symbol === 'coin' || symbol === 'gem' ? ' class="sr-only"' : ''}>${c[label]}</span><strong>${value}</strong></article>`).join('')}</div><section class="panel chart-panel"><div class="section-heading"><div><h2>${c.projectCounts}</h2><p>${view.range.start} — ${view.range.end}</p></div>${icon('chart')}</div>${summary.items.map((item,index) => `<div class="bar-row"><div class="bar-label">${icon(item.icon)}<span>${esc(state.tasks.find(task => task.id === item.taskId)?.name || item.name)}</span></div><div class="bar-track"><div class="bar-fill color-${index % 4}" style="width:${Math.round(item.count / maximum * 100)}%"></div></div><strong class="bar-count">${t('times',{ count: item.count })}</strong></div>`).join('') || empty(c.noStats)}<p class="muted chart-note">${c.statsNote}</p></section>`;
}

function productVisual(product) { return `<div class="product-illustration ${product.type}">${product.asset ? `<img src="${esc(product.asset)}" alt="${esc(product.name)}">` : icon(product.icon)}</div>`; }
function shopView() {
  const browse = view.shopTab === 'browse';
  const owned = state.owned.filter(item => view.shopTab === 'myRewards' ? item.type === 'reward' : item.type !== 'reward');
  const products = state.products.filter(product => view.productType === 'all' || product.type === view.productType);
  return `${pageHeading(c.shopTitle, c.shopSub)}<section class="shop-hero"><div><p class="eyebrow">${c.available}</p>${rewards(state.wallet.coins, state.wallet.gems)}${state.wallet.coins < 0 || state.wallet.gems < 0 ? `<p class="warning">${c.negative}</p>` : `<p>${c.adventure}</p>`}</div></section><div class="section-heading"><div class="category-tabs shop-tabs">${['browse','wardrobe','myRewards'].map(tab => button('shop-tab', c[tab], null, view.shopTab === tab ? 'active' : '', `data-tab="${tab}"`)).join('')}</div></div>${browse ? `<div class="category-tabs">${[['all', c.allProducts], ...Object.entries(c.types)].map(([type,label]) => button('product-type', label, null, view.productType === type ? 'active' : '', `data-type="${type}"`)).join('')}</div><div class="product-grid">${products.map(product => {
    const isOwned = product.type !== 'reward' && state.owned.some(item => item.productId === product.id);
    return `<article class="product-card">${productVisual(product)}<span class="product-type">${c.types[product.type]}</span><h3>${esc(product.name)}</h3><p>${esc(product.description || '')}</p><small>${product.stock === null ? c.unlimited : t('stock', { count: product.stock })}</small><div class="product-bottom">${rewards(product.coins,product.gems)}${button('buy', isOwned ? c.owned : product.stock === 0 ? c.soldOut : c.buy, null, isOwned || product.stock === 0 ? 'complete' : 'primary', `data-id="${product.id}" ${isOwned || product.stock === 0 ? 'disabled' : ''}`)}</div></article>`;
  }).join('') || empty(c.emptyProducts)}</div>` : `<div class="product-grid">${owned.map(item => `<article class="product-card">${productVisual(item)}<span class="product-type">${c.types[item.type]}</span><h3>${esc(item.name)}</h3>${item.purchasedAt ? `<small>${t('purchasedAt',{date:item.purchasedAt})}</small>` : ''}${item.redeemedAt ? `<small>${t('redeemedAt',{date:item.redeemedAt})}</small>` : ''}<div class="product-bottom">${item.type === 'reward' ? `<span class="badge">${item.status === 'pending' ? c.pending : c.redeemed}</span>${item.status === 'pending' ? button('redeem', c.redeem, 'lock', 'secondary', `data-id="${item.id}"`) : icon('check')}` : button('equip', state.equipped[item.type] === item.id ? c.unequip : c.equip, state.equipped[item.type] === item.id ? 'check' : 'plus', state.equipped[item.type] === item.id ? 'secondary' : 'primary', `data-id="${item.id}"`)}</div></article>`).join('') || empty(c.emptyOwned,c.emptyOwnedSub)}</div>`}`;
}

function loginView() {
  return `<section class="login-screen"><div class="login-art"><img src="assets/bunny.svg" alt="${c.defaultPet}"><h1>${c.brand}</h1><p>${c.brandSub}</p></div><div class="panel login-card"><p class="eyebrow">${c.adventure}</p><h2>${c.loginTitle}</h2><p>${c.loginSub}</p><form data-form="login">${field(c.username,'username','','text','required autocomplete="username"')}${field(c.password,'password','','password','required autocomplete="current-password"')}<p class="error" id="login-error" role="alert"></p><button class="primary">${c.login}${icon('arrow')}</button></form><p class="prototype-note">${c.loginDemo}</p></div></section>`;
}
function unlock(after) {
  openDialog(c.unlockTitle, `<p>${c.unlockSub}</p><form data-form="unlock">${field(c.adminPassword,'password','','password','required autocomplete="current-password"')}<p class="error" id="unlock-error" role="alert"></p><button class="primary">${icon('lock')}${c.unlock}</button></form><p class="prototype-note">${c.adminDemo}</p>`, '', (key, data) => {
    if (key !== 'submit') return;
    if (data.get('password') !== state.profile.adminPassword) { modal.querySelector('#unlock-error').textContent = c.passwordError; return; }
    closeDialog(true); after();
  });
}

// 管理区只展示当前解锁会话；离开页面即锁定。
function adminView() {
  if (!view.unlocked) return empty(c.unlockTitle);
  return `${pageHeading(c.adminTitle,c.adminSub)}<div class="admin-tabs">${Object.entries(c.adminTabs).map(([tab,label]) => button('admin-tab',label,null,view.adminTab === tab ? 'active' : '',`data-tab="${tab}"`)).join('')}${button('navigate',c.lockExit,'lock','ghost','data-page="camp"')}</div>${({ account: accountView, tasks: tasksAdminView, records: recordsAdminView, products: productsAdminView }[view.adminTab])()}`;
}
function accountView() {
  return `<div class="admin-grid"><section class="panel form-panel"><h2>${c.profile}</h2><form data-form="profile">${field(c.displayName,'name',state.profile.name,'text','required maxlength="20"')}${field(c.username,'username',state.profile.username,'text','readonly')}<p class="muted">${c.nameHelp}</p><button class="primary">${c.saveProfile}</button></form></section><section class="panel form-panel"><h2>${c.changePassword}</h2><form data-form="login-password">${field(c.currentPassword,'old','','password','required autocomplete="current-password"')}${field(c.newPassword,'next','','password','required minlength="4" autocomplete="new-password"')}${field(c.confirmPassword,'confirm','','password','required minlength="4" autocomplete="new-password"')}<button class="secondary">${c.changeLogin}</button></form><hr><form data-form="admin-password">${field(c.currentAdminPassword,'old','','password','required autocomplete="current-password"')}${field(c.newAdminPassword,'next','','password','required minlength="4" autocomplete="new-password"')}${field(c.confirmPassword,'confirm','','password','required minlength="4" autocomplete="new-password"')}<button class="secondary">${c.changeAdmin}</button></form></section></div><p class="prototype-note">${c.accountNote}</p>`;
}
function tasksAdminView() {
  return `<section class="panel form-panel"><div class="section-heading"><h2>${c.categories}</h2>${button('category-edit',c.addCategory,'plus','secondary')}</div><div class="category-management">${state.categories.map(category => `<div class="category-item"><strong>${esc(category.name)}</strong>${iconButton('category-edit',c.edit,'edit',`data-id="${category.id}"`)}${iconButton('category-delete',c.remove,'trash',`data-id="${category.id}"`)}</div>`).join('') || c.categoryEmpty}</div></section><section class="panel form-panel"><div class="section-heading"><h2>${c.taskList}</h2>${button('task-edit',c.addTask,'plus','primary')}</div><div class="table-wrap"><table><thead><tr>${[c.taskName,c.category,c.rewardColumn,c.limit,c.actions].map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${state.tasks.filter(task => task.active !== false).map(task => `<tr><td><span class="table-task">${icon(task.icon)}${esc(task.name)}</span></td><td>${esc(state.categories.find(cat => cat.id === task.categoryId)?.name || '')}</td><td>${rewards(task.coins,task.gems)}</td><td>${task.limit}</td><td><div class="table-actions">${iconButton('task-edit',c.edit,'edit',`data-id="${task.id}"`)}${iconButton('task-delete',c.remove,'trash',`data-id="${task.id}"`)}</div></td></tr>`).join('')}</tbody></table></div></section>`;
}
function recordsAdminView() {
  const records = state.records.filter(record => record.date === view.adminDate);
  return `<section class="panel form-panel"><div class="section-heading"><h2>${c.recordTable}</h2>${button('admin-add-record',c.addRecord,'plus','primary')}</div><label class="field"><span>${c.recordDate}</span><input type="date" data-change="admin-date" value="${view.adminDate}" max="${today}" required></label><div class="table-wrap"><table><thead><tr>${[c.taskColumn,c.timeColumn,c.contentColumn,c.rewardColumn,c.actions].map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${records.map(record => `<tr><td>${esc(record.name)}</td><td>${record.time}</td><td class="table-content">${esc(record.text || c.noContent)}</td><td>${rewards(record.coins,record.gems)}</td><td><div class="table-actions">${iconButton('record-detail',c.detail,'right',`data-id="${record.id}"`)}${iconButton('record-edit',c.edit,'edit',`data-id="${record.id}"`)}${iconButton('record-delete',c.remove,'trash',`data-id="${record.id}"`)}</div></td></tr>`).join('')}</tbody></table></div>${records.length ? '' : empty(c.noRecords)}</section>`;
}
function productsAdminView() {
  return `<section class="panel form-panel"><div class="section-heading"><h2>${c.adminTabs.products}</h2>${button('product-edit',c.addProduct,'plus','primary')}</div><div class="table-wrap"><table><thead><tr>${[c.productName,c.productType,currencyLabel('coin', c.coinPrice) + ' / ' + currencyLabel('gem', c.gemPrice),c.stockLabel,c.actions].map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${state.products.map(product => `<tr><td>${esc(product.name)}</td><td>${c.types[product.type]}</td><td>${rewards(product.coins,product.gems)}</td><td>${product.stock === null ? c.unlimited : product.stock}</td><td><div class="table-actions">${iconButton('product-edit',c.edit,'edit',`data-id="${product.id}"`)}${iconButton('product-delete',c.remove,'trash',`data-id="${product.id}"`)}</div></td></tr>`).join('')}</tbody></table></div></section>`;
}

// 新增和编辑共享媒体表单；录音只演示状态，不申请麦克风权限。
function checkinDialog(taskId, existing = null, redo = false) {
  const task = existing || state.tasks.find(item => item.id === taskId);
  if (!task) return;
  const admin = view.page === 'admin' && view.unlocked;
  const date = existing?.date || (admin ? view.adminDate : today);
  let photo = redo ? null : existing?.photo || null;
  let audio = redo ? false : existing?.audio || false;
  let seconds = audio?.seconds || (audio ? 12 : 0);
  let recording = false;
  let timer;
  let failSubmit = false;
  let submitting = false;
  let active = true;
  let mode = 'normal';
  const controls = () => {
    const target = modal.querySelector('#recorder-state');
    if (!target) return;
    target.dataset.recording = recording;
    target.innerHTML = mode !== 'normal' ? `<p class="error" role="alert">${mode === 'permission' ? c.mediaPermission : c.mediaError}</p>` : `<div class="record-controls">${recording ? `<span class="recording-dot"></span><strong>${t('recording',{seconds})}</strong>${button('record-stop',c.recordStop,'stop','danger')}` : audio ? `<span>${t('recorded',{seconds})}</span>${button('record-play',c.recordPlay,'play','secondary')}${button('record-start',c.recordAgain,'mic','ghost')}${iconButton('record-remove',c.recordRemove,'trash')}` : button('record-start',c.recordStart,'mic','secondary')}</div>`;
  };
  const stopRecording = () => { clearInterval(timer); recording = false; audio = { seconds: Math.max(seconds, 1) }; dialogDirty = true; controls(); updateMusic(); };
  openDialog(existing ? c.editTitle : c.checkinTitle,
    `<div class="checkin-summary"><span class="task-icon ${task.color || 'green'}">${icon(task.icon)}</span><div><h3>${esc(task.name)}</h3><p class="muted">${dateLabel(date,true)}</p></div>${!existing || admin ? rewards(task.coins,task.gems,true) : ''}</div>${redo ? `<p class="muted">${c.redoHint}</p>` : ''}<form id="checkin-form" data-form="checkin"><label class="field"><span>${c.textLabel} <small>${c.optional}</small></span><textarea name="text" rows="3" maxlength="1000" placeholder="${c.textPlaceholder}">${esc(redo ? '' : existing?.text || '')}</textarea></label><label class="field"><span>${c.photo} <small>${c.optional}</small></span><span class="upload-area">${icon('camera')}<span>${c.photoHint}</span><input type="file" name="photo" accept="image/*" capture="environment" aria-label="${c.photo}"></span></label><div id="photo-preview" class="media-preview">${photo ? `<img src="${photo}" alt="${c.photoAlt}">${button('photo-remove',c.removePhoto,'trash','ghost')}` : ''}</div><div class="field"><span>${c.voice} <small>${c.optional}</small></span><div class="recorder"><p>${c.voiceHint}</p><small class="muted">${c.mediaDemo}</small><div id="recorder-state"></div></div></div><details class="prototype-controls"><summary>${c.prototypeShort}</summary><p>${c.mediaDemo}</p><div class="record-controls">${button('media-mode',c.mediaUnavailable,null,'ghost','data-mode="permission"')}${button('media-mode',c.mediaFailure,null,'ghost','data-mode="error"')}${button('media-mode',c.mediaNormal,null,'ghost','data-mode="normal"')}<label><input type="checkbox" name="fail">${c.simulateFail}</label></div></details><p id="submit-error" class="error" role="alert"></p></form>`,
    button('close-modal',c.cancel,null,'secondary') + `<button type="submit" form="checkin-form" class="primary" id="checkin-submit">${icon('check')}${existing ? c.save : c.checkinConfirm}</button>`,
    (key, data, element) => {
      if (key === 'photo-remove') { photo = null; modal.querySelector('#photo-preview').innerHTML = ''; modal.querySelector('input[type="file"]').value = ''; dialogDirty = true; }
      if (key === 'record-start') { dialogDirty = true; seconds = 0; audio = false; recording = true; controls(); updateMusic(); timer = setInterval(() => { seconds += 1; if (seconds >= 60) stopRecording(); else controls(); },1000); }
      if (key === 'record-stop') stopRecording();
      if (key === 'record-remove') { audio = false; seconds = 0; controls(); dialogDirty = true; }
      if (key === 'record-play') { tone(523,.3); setTimeout(() => tone(659,.3),300); notify(c.mediaDemo); }
      if (key === 'media-mode') { clearInterval(timer); recording = false; mode = element.dataset.mode; controls(); updateMusic(); }
      if (key !== 'submit' || submitting) return;
      if (recording) stopRecording();
      failSubmit = data.has('fail'); submitting = true;
      const submit = modal.querySelector('#checkin-submit'); submit.disabled = true; submit.textContent = c.saving;
      setTimeout(() => {
        if (!active) return;
        submitting = false;
        if (failSubmit) { modal.querySelector('#submit-error').textContent = c.submitFailed; modal.querySelector('[name="fail"]').checked = false; submit.disabled = false; submit.textContent = c.retry; return; }
        try {
          const content = { text: data.get('text').trim(), photo, audio };
          const next = existing ? editRecord(state, existing.id, content, {admin,today}) : addRecord(state, taskId, { date, ...content }, {admin,today});
          closeDialog(true); commit(next,existing ? c.updated : c.saved); if (!existing) celebrate();
        } catch(error) { modal.querySelector('#submit-error').textContent = c.errors[error.code || error.message] || c.errors.UNKNOWN; submit.disabled = false; submit.textContent = c.retry; }
      },450);
    }, () => { active = false; clearInterval(timer); recording = false; });
  controls();
  modal.querySelector('input[type="file"]').addEventListener('change', event => {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 2 * 1024 * 1024) { notify(c.photoLimit); event.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => { if (!active) return; photo = reader.result; modal.querySelector('#photo-preview').innerHTML = `<img src="${photo}" alt="${c.photoAlt}">${button('photo-remove',c.removePhoto,'trash','ghost')}`; dialogDirty = true; };
    reader.onerror = () => notify(c.photoFailed); reader.readAsDataURL(file);
  });
}
function recordDetail(id) {
  const record = state.records.find(item => item.id === id);
  if (!record) return;
  const admin = view.page === 'admin' && view.unlocked;
  const editable = record.date === today || admin;
  openDialog(c.detailTitle, `<div class="checkin-summary"><span class="task-icon green">${icon(record.icon)}</span><div><h3>${esc(record.name)}</h3><p>${dateLabel(record.date,true)} · ${record.time}</p></div>${admin ? rewards(record.coins,record.gems,true) : ''}</div><p class="record-text">${esc(record.text || c.noContent)}</p>${record.photo ? `<div class="media-preview"><img src="${record.photo}" alt="${c.photoAlt}"></div>` : ''}${record.audio ? `<div class="recorder"><p>${t('recorded',{seconds:record.audio.seconds || 12})}</p>${button('record-sample',c.recordPlay,'play','secondary')}<small>${c.mediaDemo}</small></div>` : ''}${editable ? '' : `<p class="muted">${c.readonly}</p>`}`,
    editable ? button('record-delete',c.remove,'trash','ghost',`data-id="${id}"`) + button('record-redo',c.redo,null,'secondary',`data-id="${id}"`) + button('record-edit',c.edit,'edit','primary',`data-id="${id}"`) : button('close-modal',c.close,null,'secondary'), key => { if (key === 'record-sample') { tone(); notify(c.mediaDemo); } });
}
function deleteRecordDialog(id) {
  const record = state.records.find(item => item.id === id);
  if (!record) return;
  confirmation(c.deleteRecordTitle,`<p>${c.deleteRecordBody}</p>${rewards(-record.coins,-record.gems)}`, () => commit(deleteRecord(state,id,{admin:view.page === 'admin' && view.unlocked,today}),c.deleted),c.remove,true);
}
function categoryDialog(id) {
  const category = state.categories.find(item => item.id === id);
  openDialog(category ? c.edit : c.addCategory, `<form id="category-form" data-form="category">${field(c.categoryName,'name',category?.name || '','text','required maxlength="20"')}</form>`, button('close-modal',c.cancel,null,'secondary') + `<button class="primary" form="category-form">${c.save}</button>`, (key,data) => {
    if (key !== 'submit') return;
    const name = data.get('name').trim(); if (!name) return;
    const categories = category ? state.categories.map(item => item.id === id ? {...item,name} : item) : [...state.categories,{id:crypto.randomUUID(),name}];
    closeDialog(true); commit({...state,categories});
  });
}
function taskDialog(id) {
  const task = state.tasks.find(item => item.id === id);
  if (!state.categories.length) { categoryDialog(); return; }
  openDialog(task ? c.edit : c.addTask, `<form id="task-form" data-form="task">${field(c.taskName,'name',task?.name || '','text','required maxlength="30"')}<div class="form-grid">${selectField(c.category,'categoryId',state.categories.map(item => [item.id,item.name]),task?.categoryId || state.categories[0].id)}${selectField(c.taskIcon,'icon',Object.entries(c.iconNames),task?.icon || 'star')}${field(currencyLabel('coin',c.coinReward),'coins',task?.coins ?? 10,'number','required min="0" step="1" max="9999"')}${field(currencyLabel('gem',c.gemReward),'gems',task?.gems ?? 1,'number','required min="0" step="1" max="9999"')}${field(c.limit,'limit',task?.limit ?? 1,'number','required min="1" step="1" max="99"')}</div><fieldset class="weekday-options"><legend>${c.weekdays}</legend>${weekDays(today).map(date => { const day = new Date(`${date}T12:00:00`).getDay(); return `<label><input type="checkbox" name="weekdays" value="${day}" ${!task || task.weekdays.includes(day) ? 'checked' : ''}>${weekdayLabel(date)}</label>`; }).join('')}</fieldset><p class="error" id="task-error" role="alert"></p></form>`,button('close-modal',c.cancel,null,'secondary') + `<button class="primary" form="task-form">${c.save}</button>`,(key,data) => {
    if (key !== 'submit') return;
    const weekdays = data.getAll('weekdays').map(Number);
    if (!weekdays.length) { modal.querySelector('#task-error').textContent = c.chooseWeekday; return; }
    const next = { ...task, id: task?.id || crypto.randomUUID(), name:data.get('name').trim(), categoryId:data.get('categoryId'), icon:data.get('icon'), color:task?.color || 'green', coins:Number(data.get('coins')), gems:Number(data.get('gems')), limit:Number(data.get('limit')), weekdays, active:true };
    if (!next.name) return;
    closeDialog(true); commit({...state,tasks:task ? state.tasks.map(item => item.id === id ? next : item) : [...state.tasks,next]},c.taskSaved);
  });
}
function productDialog(id) {
  const product = state.products.find(item => item.id === id);
  const fixedType = product && state.owned.some(item => item.productId === id);
  openDialog(product ? c.edit : c.addProduct,`<form id="product-form" data-form="product">${field(c.productName,'name',product?.name || '','text','required maxlength="30"')}${field(c.description,'description',product?.description || '','text','maxlength="70"')}<div class="form-grid">${selectField(c.productType,'type',Object.entries(c.types),product?.type || 'reward',fixedType ? 'disabled' : '')}${selectField(c.productIcon,'icon',Object.entries(c.iconNames),product?.icon || 'gift')}${selectField(c.productAsset,'asset',Object.entries(c.assetNames),product?.asset || 'assets/bunny.svg')}${field(currencyLabel('coin',c.coinPrice),'coins',product?.coins ?? 50,'number','required min="0" step="1" max="99999"')}${field(currencyLabel('gem',c.gemPrice),'gems',product?.gems ?? 0,'number','required min="0" step="1" max="99999"')}${field(c.stockLabel,'stock',product?.stock ?? '','number','min="0" step="1" max="99999"')}</div><p class="muted">${c.stockHelp}</p></form>`,button('close-modal',c.cancel,null,'secondary') + `<button class="primary" form="product-form">${c.save}</button>`,(key,data) => {
    if (key !== 'submit') return;
    const type = fixedType ? product.type : data.get('type');
    const next = {id:product?.id || crypto.randomUUID(),name:data.get('name').trim(),description:data.get('description').trim(),type,icon:data.get('icon'),coins:Number(data.get('coins')),gems:Number(data.get('gems')),stock:data.get('stock') === '' ? null : Number(data.get('stock')),...(type === 'avatar' ? {asset:data.get('asset')} : {})};
    if (!next.name) return;
    closeDialog(true); commit({...state,products:product ? state.products.map(item => item.id === id ? next : item) : [...state.products,next]},c.productSaved);
  });
}
function addAdminRecord() {
  const tasks = eligibleTasks(state.tasks,state.records,view.adminDate);
  if (!tasks.length) { notify(c.noEligible); return; }
  openDialog(c.addRecord,`<form id="choose-task-form" data-form="choose-task">${selectField(c.chooseTask,'task',tasks.map(task => [task.id,task.name]),tasks[0].id)}</form>`,button('close-modal',c.cancel,null,'secondary') + `<button class="primary" form="choose-task-form">${c.next}</button>`,(key,data) => { if (key === 'submit') checkinDialog(data.get('task')); });
}

// 事件委托保持页面重绘后按钮行为一致。
function navigate(page) {
  if (view.page === 'admin' && page !== 'admin') view.unlocked = false;
  view.page = page; render(); window.scrollTo({top:0,behavior:'instant'});
}
function handleAction(element) {
  const { action, id } = element.dataset;
  if (action === 'close-modal') { closeDialog(); return; }
  const local = dialogAction;
  if (modal.open && local) local(action,null,element);
  switch(action) {
    case 'navigate': navigate(element.dataset.page); break;
    case 'view-mode': view.mode = element.dataset.mode; render(); break;
    case 'shift-date': view.date = dateShift(view.date,Number(element.dataset.step) * (view.mode === 'week' ? 7 : 1)); render(); break;
    case 'today': view.date = today; render(); break;
    case 'category': view.category = id; render(); break;
    case 'checkin': checkinDialog(id); break;
    case 'record-detail': recordDetail(id); break;
    case 'record-edit': checkinDialog(null,state.records.find(item => item.id === id)); break;
    case 'record-redo': checkinDialog(null,state.records.find(item => item.id === id),true); break;
    case 'record-delete': deleteRecordDialog(id); break;
    case 'this-month': view.month = today.slice(0,7); view.date = today; render(); break;
    case 'calendar-date': view.date = element.dataset.date; render(); break;
    case 'shift-month': { const date = new Date(`${view.month}-01T12:00:00`); date.setMonth(date.getMonth()+Number(element.dataset.step)); view.month = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`; view.date = `${view.month}-01`; render(); break; }
    case 'range': view.preset = element.dataset.preset; if (view.preset !== 'custom') view.range = rangeFor(view.preset,today); render(); if (view.preset === 'custom') app.querySelector('[name="start"]').focus(); break;
    case 'shop-tab': view.shopTab = element.dataset.tab; render(); break;
    case 'product-type': view.productType = element.dataset.type; render(); break;
    case 'buy': { const product = state.products.find(item => item.id === id); confirmation(c.purchaseTitle,`<p>${t('purchaseBody',product)}</p>${rewards(product.coins,product.gems)}<p class="muted">${c.balanceAfter}</p>${rewards(state.wallet.coins-product.coins,state.wallet.gems-product.gems)}`,() => { const next = purchase(state,id); next.owned.at(-1).purchasedAt = today; commit(next,c.purchased); celebrate(); },c.confirmBuy); break; }
    case 'equip': { const item = state.owned.find(item => item.id === id); commit({...state,equipped:{...state.equipped,[item.type]:state.equipped[item.type] === id ? null : id}}); break; }
    case 'redeem': { const item = state.owned.find(item => item.id === id); unlock(() => confirmation(c.redeemTitle,`<p>${t('redeemBody',item)}</p>`,() => commit({...state,owned:state.owned.map(owned => owned.id === id ? {...owned,status:'redeemed',redeemedAt:today} : owned)}),c.redeem)); break; }
    case 'delete-message': confirmation(c.deleteMessage,`<p>${esc(state.messages.find(item => item.id === id)?.text || '')}</p>`,() => commit({...state,messages:state.messages.filter(item => item.id !== id)}),c.remove,true); break;
    case 'admin': unlock(() => { view.unlocked = true; navigate('admin'); }); break;
    case 'admin-tab': view.adminTab = element.dataset.tab; render(); break;
    case 'category-edit': categoryDialog(id); break;
    case 'category-delete': if (state.tasks.some(item => item.categoryId === id && item.active !== false)) notify(c.categoryDeleteBody); else confirmation(c.categoryDelete, '', () => commit({...state,categories:state.categories.filter(item => item.id !== id)}),c.remove,true); break;
    case 'task-edit': taskDialog(id); break;
    case 'task-delete': confirmation(c.taskDeleteTitle,`<p>${c.taskDeleteBody}</p>`,() => commit({...state,tasks:state.tasks.map(item => item.id === id ? {...item,active:false} : item)}),c.remove,true); break;
    case 'product-edit': productDialog(id); break;
    case 'product-delete': confirmation(c.productDeleteTitle,`<p>${c.productDeleteBody}</p>`,() => commit({...state,products:state.products.filter(item => item.id !== id)}),c.remove,true); break;
    case 'admin-add-record': addAdminRecord(); break;
    case 'music': view.music = !view.music; updateMusic(); renderHeader(); break;
    case 'sound': view.sound = !view.sound; renderHeader(); break;
    case 'motion': view.reduced = !view.reduced; render(); break;
    case 'logout': view.logged = false; view.unlocked = false; view.music = false; updateMusic(); sessionStorage.setItem('island-logged','false'); render(); break;
    case 'reset': confirmation(c.reset,c.resetQuestion,() => { state = createSeed(); view.unlocked = false; view.page = 'camp'; view.date = today; view.month = today.slice(0,7); view.category = 'all'; persist(); render(); }); break;
  }
}
document.addEventListener('click', event => {
  const element = event.target.closest('[data-action]');
  if (!element) return;
  event.preventDefault(); run(() => handleAction(element));
});
document.addEventListener('submit', event => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  if (modal.contains(form)) { run(() => dialogAction?.('submit',data,form)); return; }
  run(() => {
    switch(form.dataset.form) {
      case 'message': { const text = data.get('message').trim(); if (!text) { notify(c.noteEmpty); return; } view.messageDraft = ''; form.reset(); commit({...state,messages:[{id:crypto.randomUUID(),text,date:today},...state.messages]},c.messageSent); break; }
      case 'login': if (data.get('username') === state.profile.username && data.get('password') === state.profile.password) { view.logged = true; view.page = 'camp'; sessionStorage.setItem('island-logged','true'); render(); } else form.querySelector('#login-error').textContent = c.loginError; break;
      case 'range': { const start = data.get('start'), end = data.get('end'); if (!start || !end || start > end || end > today) { notify(c.invalidRange); return; } view.range = {start,end}; view.preset = 'custom'; render(); break; }
      case 'profile': { const name = data.get('name').trim(); if (!name) return; commit({...state,profile:{...state.profile,name}},c.profileSaved); break; }
      case 'login-password': case 'admin-password': { const key = form.dataset.form === 'login-password' ? 'password' : 'adminPassword'; if (data.get('old') !== state.profile[key]) { notify(c.oldPasswordError); return; } if (data.get('next') !== data.get('confirm')) { notify(c.passwordMismatch); return; } commit({...state,profile:{...state.profile,[key]:data.get('next')}},c.passwordSaved); break; }
    }
  });
});
document.addEventListener('change', event => {
  if (event.target.dataset.change !== 'admin-date') return;
  if (!event.target.value || event.target.value > today) { event.target.value = view.adminDate; notify(c.errors.FUTURE_DATE); return; }
  view.adminDate = event.target.value; render();
});
document.addEventListener('visibilitychange',updateMusic);
render();
