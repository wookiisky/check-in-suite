import type { MediaDraft } from '../media/media-draft';
import type { Checkin, CheckinClient, Task } from './types';

/** 尚未发送的内容与未知命令分开保存，权限恢复后可继续上传未完成部分。 */
export interface CheckinDraft {
  task: Task; // 原任务，避免恢复时把内容套到另一任务。
  date: string; // 用户确认的日期，跨日不静默更换。
  management: boolean; // 原页面入口。
  text: string; // 未提交或后续修改的文字。
  media: MediaDraft; // 已成功上传的ID和仍需上传的文件。
  record: Checkin | null; // 编辑记录的最新已知版本。
  needsManagement: boolean; // 普通跨日修改需在管理入口重新确认。
}

/** 单账户页面的一份新增草稿，编辑草稿按记录ID保存。 */
export const CREATE_DRAFT_KEY = 'create';
const drafts = new WeakMap<CheckinClient, Map<string, CheckinDraft>>();

/** 保存草稿不表示业务命令已经发送，也不会生成幂等键。 */
export function rememberDraft(client: CheckinClient, key: string, draft: CheckinDraft | null): void {
  if (!draft) { drafts.get(client)?.delete(key); return; }
  let items = drafts.get(client);
  if (!items) { items = new Map(); drafts.set(client, items); }
  items.set(key, draft);
}

/** 授权恢复后显式重新进入原任务或记录继续编辑。 */
export function getDraft(client: CheckinClient, key: string): CheckinDraft | null {
  return drafts.get(client)?.get(key) ?? null;
}
