import { demo } from '../config/content.mjs';
import { todayKey, dateShift } from './domain.mjs';

/** 构造随当天日期移动的示例，便于查看周、月及跨月统计。 */
export function createSeed() {
  const today = todayKey();
  const records = [];
  for (let offset = 28; offset >= 0; offset -= 1) {
    if (offset > 0 && offset % 6 === 0) continue;
    const tasks = offset === 0 ? [demo.tasks[4], demo.tasks[0]] : demo.tasks.filter((_, index) => (offset + index) % 3 === 0);
    tasks.forEach((task, index) => records.push({
      id: `seed-${offset}-${index}`, taskId: task.id, name: task.name, icon: task.icon,
      coins: task.coins, gems: task.gems, date: dateShift(today, -offset), time: index ? '09:20' : '07:30',
      text: demo.sampleNotes[index % demo.sampleNotes.length], photo: null, audio: false,
    }));
  }
  return {
    ...structuredClone(demo), records, wallet: { coins: 286, gems: 24 }, owned: [], equipped: { title: null, avatar: null, accessory: null },
    messages: demo.messages.map((text, index) => ({ id: `message-${index}`, text, date: dateShift(today, -index) })),
  };
}
