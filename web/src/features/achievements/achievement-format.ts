import { ApiFailure, errorMessage } from '../../api/client';
import type { AchievementInput } from './types';
import content from './content.json';

// 规则摘要从文案资源拼装，不向用户暴露内部标识。
export function achievementRule(item: AchievementInput): string {
  return content.ruleTemplate.replace('{scope}', content.scopes[item.scope]).replace('{metric}', content.metrics[item.metric]).replace('{target}', String(item.target)).replace('{unit}', content.units[item.metric]);
}

// 历史关联继续显示名称，以状态标记说明它已退出当前配置。
export function achievementTargetName(target: { name: string; deleted: boolean }): string {
  return target.deleted ? content.deletedTarget.replace('{name}', () => target.name) : target.name;
}

// 限时指任意历史窗口，不是从今天倒数。
export function achievementWindow(days: number | null): string {
  return days === null ? content.unlimitedHint : content.windowTemplate.replace('{days}', String(days));
}

// 错误码只用于选择用户文案，未知错误沿用应用统一处理。
export function achievementError(error: unknown): string {
  return error instanceof ApiFailure ? content.errors[error.detail.code as keyof typeof content.errors] ?? errorMessage(error) : errorMessage(error);
}

// 成功状态响应丢失也属于未知结果，新增必须保留原请求。
export function isUncertainCreation(error: unknown): boolean {
  return !(error instanceof ApiFailure) || error.status === 0 || error.status === 401 || error.status === 403 || error.status >= 500 || error.detail.code === 'INVALID_RESPONSE';
}

// 获得时间按照站点时区展示。
export function achievementTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

// 内置图片通过同源鉴权接口读取。
export function badgeURL(key: string): string { return `/api/v1/assets/${encodeURIComponent(key)}`; }
