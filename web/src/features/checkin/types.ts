import type { ApiClient } from '../../api/client';
import type { Session } from '../../api/types';
import type { components } from '../../api/schema';

/** 功能类型直接来自 OpenAPI，避免手写响应与服务端分叉。 */
export type Category = components['schemas']['Category'];
export type Task = components['schemas']['Task'] & { remaining?: number };
export type Wallet = components['schemas']['Wallet'];
export type Checkin = components['schemas']['Checkin'];
export type Camp = components['schemas']['CampResponse'];
export type CheckinResult = components['schemas']['CheckinResult'];
export type CheckinPage = components['schemas']['CheckinList'];

/** 普通新增和管理补录共用草稿，路径决定服务端授权。 */
export interface CreateCheckin {
  task_id: string; // 确认的任务。
  expected_task_version: number; // 打开弹窗时的配置版本。
  expected_today?: string; // 普通打卡确认日期。
  business_date?: string; // 管理补录目标日期。
  text: string; // 提交时文字快照。
  photo_media_id: string | null; // 已上传照片。
  audio_media_id: string | null; // 已上传录音。
}

/** 功能只依赖请求方法，便于以协议行为测试组件。 */
export type CheckinClient = Pick<ApiClient, 'request'>;

/** 营地与管理功能从上层取得同一登录会话。 */
export interface CheckinProps {
  client: CheckinClient; // 已绑定 CSRF 的客户端。
  session: Session; // 当前账户与生效限制。
}
