const TIME_ZONE = 'Asia/Taipei';

// 日期归属始终使用家庭时区，不跟随设备时区变化。
export function todayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// 用 UTC 运算纯日期，避免设备夏令时造成跨日误差。
export function dateShift(key, days) {
  const value = new Date(`${key}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// 返回日期所属周的周一至周日。
export function weekDays(key) {
  const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
  const monday = dateShift(key, -((weekday + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => dateShift(monday, index));
}

// 只返回本月真实日期，日历补位由展示层处理。
export function monthDays(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const count = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}

// 统计快捷范围包含今天，本周和本月均截至今天。
export function rangeFor(preset, today) {
  if (preset === 'week') return { start: weekDays(today)[0], end: today };
  if (preset === 'month') return { start: `${today.slice(0, 7)}-01`, end: today };
  if (preset === '7' || preset === 7) return { start: dateShift(today, -6), end: today };
  if (preset === '30' || preset === 30) return { start: dateShift(today, -29), end: today };
  throw new Error('INVALID_RANGE');
}

// 按启用状态、星期和有效记录数量判断当天是否还能打卡。
export function eligibleTasks(tasks, records, date) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return tasks.filter(task => task.active !== false
    && task.weekdays.includes(weekday)
    && records.filter(record => record.taskId === task.id && record.date === date).length < (task.limit ?? 1));
}

// 同一项目改名后仍归并统计；奖励是记录快照之和，不代表可用余额。
export function summarize(records, start, end) {
  const selected = records.filter(record => record.date >= start && record.date <= end);
  const groups = new Map();
  let coins = 0;
  let gems = 0;
  for (const record of selected) {
    const item = groups.get(record.taskId) ?? { taskId: record.taskId, name: record.name, icon: record.icon, count: 0 };
    item.count += 1;
    groups.set(record.taskId, item);
    coins += record.coins;
    gems += record.gems;
  }
  return {
    total: selected.length,
    days: new Set(selected.map(record => record.date)).size,
    coins,
    gems,
    items: [...groups.values()].sort((left, right) => right.count - left.count),
  };
}

// 错误只携带稳定代码，中文提示由界面配置映射。
function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

// 管理补录不能面向未来；普通操作只允许当天。
function assertEditableDate(date, admin, today) {
  if (date > today) fail('FUTURE_DATE');
  if (!admin && date !== today) fail('TODAY_ONLY');
}

// 新增时固定项目快照，并且只在记录成功建立后增加奖励。
export function addRecord(state, taskId, { date, text = '', photo = null, audio = false }, { admin = false, today = todayKey() } = {}) {
  assertEditableDate(date, admin, today);
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) fail('NOT_FOUND');
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (task.active === false || !task.weekdays.includes(weekday)) fail('TASK_UNAVAILABLE');
  const count = state.records.filter(record => record.taskId === taskId && record.date === date).length;
  if (count >= (task.limit ?? 1)) fail('LIMIT_REACHED');
  const record = {
    id: crypto.randomUUID(), taskId: task.id, name: task.name, icon: task.icon,
    coins: task.coins, gems: task.gems, date,
    time: new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()),
    text, photo, audio,
  };
  return {
    ...state,
    records: [...state.records, record],
    wallet: { coins: state.wallet.coins + record.coins, gems: state.wallet.gems + record.gems },
  };
}

// 删除回收该记录原奖励；允许负余额且不影响已经拥有的物品。
export function deleteRecord(state, id, { admin = false, today = todayKey() } = {}) {
  const record = state.records.find(item => item.id === id);
  if (!record) fail('NOT_FOUND');
  assertEditableDate(record.date, admin, today);
  return {
    ...state,
    records: state.records.filter(item => item.id !== id),
    wallet: { coins: state.wallet.coins - record.coins, gems: state.wallet.gems - record.gems },
  };
}

// 编辑仅允许替换内容，禁止通过附件修改路径改变奖励或日期。
export function editRecord(state, id, patch, { admin = false, today = todayKey() } = {}) {
  const record = state.records.find(item => item.id === id);
  if (!record) fail('NOT_FOUND');
  assertEditableDate(record.date, admin, today);
  const content = Object.fromEntries(['text', 'photo', 'audio'].filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]]));
  return { ...state, records: state.records.map(item => item.id === id ? { ...item, ...content } : item) };
}

// 购买一次完成余额、库存和所有物更新；文本奖励允许重复购买。
export function purchase(state, productId) {
  const product = state.products.find(item => item.id === productId);
  if (!product) fail('NOT_FOUND');
  if (product.type !== 'reward' && state.owned.some(item => item.productId === productId)) fail('ALREADY_OWNED');
  if (product.stock !== null && product.stock <= 0) fail('SOLD_OUT');
  if (state.wallet.coins < product.coins || state.wallet.gems < product.gems) fail('INSUFFICIENT_BALANCE');
  const owned = {
    id: crypto.randomUUID(), productId: product.id, name: product.name, type: product.type,
    icon: product.icon, status: product.type === 'reward' ? 'pending' : 'owned',
    ...(product.asset ? { asset: product.asset } : {}),
  };
  return {
    ...state,
    wallet: { coins: state.wallet.coins - product.coins, gems: state.wallet.gems - product.gems },
    products: state.products.map(item => item.id === productId && item.stock !== null ? { ...item, stock: item.stock - 1 } : item),
    owned: [...state.owned, owned],
  };
}
