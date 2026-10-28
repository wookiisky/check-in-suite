import { ApiFailure } from '../../api/client';
import type { components } from '../../api/schema';
import type { MediaDraft } from '../media/media-draft';
import type { Checkin, CheckinClient } from './types';
import { readCurrentRecord } from './records';

type MediaReferences = Pick<Checkin, 'photo_media_id' | 'audio_media_id'>;

/** 未确认编辑保留原版本和附件，重开同一记录仍先核对原PATCH。 */
export interface PendingEdit {
  readonly path: string; // 普通或管理编辑路径。
  readonly record: Checkin; // 原记录快照。
  readonly body: Readonly<components['schemas']['CheckinUpdate']>; // 发送过的原始内容。
  draftText: string; // 结果未知期间可继续修改的文字。
  draftMedia: MediaDraft; // 结果未知期间可继续选择的附件。
}

/** 只在当前客户端内保存未知编辑，不将家庭内容写入持久存储。 */
const edits = new WeakMap<CheckinClient, Map<string, PendingEdit>>();

/** 逐记录保留未知编辑，避免不同记录互相覆盖。 */
export function rememberEdit(client: CheckinClient, id: string, pending: PendingEdit | null): void {
  if (!pending) { edits.get(client)?.delete(id); return; }
  let records = edits.get(client);
  if (!records) { records = new Map(); edits.set(client, records); }
  records.set(id, pending);
}

/** 打开记录编辑时恢复之前尚未确认的命令。 */
export function getPendingEdit(client: CheckinClient, id: string): PendingEdit | null {
  return edits.get(client)?.get(id) ?? null;
}

/** 当前草稿中仍需要的媒体不能被取消上传清理。 */
export function draftMediaIDs(draft: MediaDraft): string[] {
  return [draft.photo?.mediaId, draft.audio?.mediaId].filter((id): id is string => Boolean(id));
}

/** 未上传的新文件即使尚无ID，也代表与原请求不同的内容。 */
export function mediaMatches(draft: MediaDraft, references: MediaReferences): boolean {
  return (draft.photo?.mediaId ?? null) === references.photo_media_id && (draft.audio?.mediaId ?? null) === references.audio_media_id && !(draft.photo?.file && !draft.photo.mediaId) && !(draft.audio?.file && !draft.audio.mediaId);
}

/** 成功记录引用的附件更新为已关联，后续替换不走取消上传接口。 */
export function markAttached(draft: MediaDraft, record: MediaReferences): MediaDraft {
  return {
    photo: draft.photo && { ...draft.photo, attached: Boolean(draft.photo.mediaId && draft.photo.mediaId === record.photo_media_id) },
    audio: draft.audio && { ...draft.audio, attached: Boolean(draft.audio.mediaId && draft.audio.mediaId === record.audio_media_id) },
  };
}

/** 明确拒绝已过期附件后才清除临时ID，保留原文件供用户重新提交。 */
export function renewUnavailableMedia(draft: MediaDraft): MediaDraft {
  return {
    photo: draft.photo && !draft.photo.attached && draft.photo.file ? { ...draft.photo, mediaId: null } : draft.photo,
    audio: draft.audio && !draft.audio.attached && draft.audio.file ? { ...draft.audio, mediaId: null } : draft.audio,
  };
}

/** 原版本PATCH最多生效一次；版本已变时读取现状核对，不自动覆盖新内容。 */
export async function replayEdit(client: CheckinClient, pending: PendingEdit): Promise<{ record: Checkin; applied: boolean; requiresManagement: boolean }> {
  try {
    return { record: await client.request<Checkin>(pending.path, { method: 'PATCH', body: pending.body }), applied: true, requiresManagement: false };
  } catch (error) {
    if (!(error instanceof ApiFailure) || !['VERSION_CONFLICT', 'HISTORY_READ_ONLY'].includes(error.detail.code)) throw error;
    const current = await readCurrentRecord(client, pending.record);
    return { record: current, applied: current.text === pending.body.text && current.photo_media_id === pending.body.photo_media_id && current.audio_media_id === pending.body.audio_media_id, requiresManagement: error.detail.code === 'HISTORY_READ_ONLY' };
  }
}
