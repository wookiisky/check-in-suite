import { ApiFailure, errorMessage } from '../../api/client';
import content from './content.json';

export { shiftDate as moveDate } from '../../api/dates';

/** 真实操作时间固定按站点时区显示。 */
export function operationTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

/** 业务错误从本功能资源映射，基础错误交给公共请求模块。 */
export function checkinError(error: unknown): string {
  const code = error instanceof ApiFailure ? error.detail.code : '';
  return content.errors[code as keyof typeof content.errors] ?? errorMessage(error);
}

/** 只有明确业务拒绝才允许重新提交；失联、权限失效和不完整响应保留原命令。 */
export function isDefiniteFailure(error: unknown): boolean {
  return error instanceof ApiFailure && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403 && error.detail.code !== 'INVALID_RESPONSE';
}
