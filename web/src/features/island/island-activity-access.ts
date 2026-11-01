import type { components, paths } from '../../api/schema';

export type IslandActivity = components['schemas']['IslandActivity'];
export type IslandAccess = paths['/api/v1/island/activity-access']['get']['responses'][200]['content']['application/json'];

// 每次使用时检查期限，后台节流后的旧计时器也不能延长昨日资格。
export function allowedIslandActivities(access: IslandAccess | null, now = Date.now()): IslandActivity[] {
  if (!access) return [];
  const valid = Date.parse(access.expires_at) > now;
  return access.activity_access.filter((item) => item.available && (valid || item.tasks.length === 0)).map((item) => item.activity);
}
