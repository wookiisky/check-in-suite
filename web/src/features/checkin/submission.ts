import { emptyMediaDraft } from '../media/media-draft';
import type { MediaDraft } from '../media/media-draft';
import type { CheckinClient, CheckinResult, CreateCheckin, Task } from './types';

/** 原提交与可继续编辑的草稿分开保存，结果未知时禁止另起新命令。 */
export interface PendingCheckin {
  readonly key: string; // 一次确认只生成一个幂等键。
  readonly path: string; // 服务端固定普通或管理权限入口。
  readonly body: Readonly<CreateCheckin>; // 原始业务请求，重放不得替换。
  readonly task: Task; // 原弹窗任务，用于恢复界面。
  draftMedia: MediaDraft; // 用户后续选择的附件，与原请求媒体ID分开。
  draftText: string; // 用户后续编辑的草稿不覆盖原请求。
}

/** 未知提交在页面切换期间保留于内存，不将家庭文字写入浏览器存储。 */
const pendingByClient = new WeakMap<CheckinClient, PendingCheckin>();

/** 创建固定请求快照，日期在用户确认时锁定。 */
export function createPendingCheckin(task: Task, date: string, text: string, management: boolean, media: MediaDraft = emptyMediaDraft()): PendingCheckin {
  return { key: crypto.randomUUID(), path: management ? '/management/checkins' : '/checkins', task, draftText: text, draftMedia: media, body: Object.freeze({ task_id: task.id, expected_task_version: task.version, ...(management ? { business_date: date } : { expected_today: date }), text, photo_media_id: media.photo?.mediaId ?? null, audio_media_id: media.audio?.mediaId ?? null }) };
}

/** 保存或清除当前客户端唯一未确认提交。 */
export function rememberPending(client: CheckinClient, pending: PendingCheckin | null): void {
  if (pending) pendingByClient.set(client, pending);
  else pendingByClient.delete(client);
}

/** 重新进入营地时优先恢复未确认命令。 */
export function getPending(client: CheckinClient): PendingCheckin | null {
  return pendingByClient.get(client) ?? null;
}

/** 所有恢复均使用原键和原始请求，绝不自行创建第二条记录。 */
export function replayCheckin(client: CheckinClient, pending: PendingCheckin): Promise<CheckinResult> {
  return client.request<CheckinResult>(pending.path, { method: 'POST', body: pending.body, idempotencyKey: pending.key });
}
