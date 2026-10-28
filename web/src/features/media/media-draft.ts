import type { ApiClient } from '../../api/client';
import type { components } from '../../api/schema';

// 已关联附件与本次上传的临时附件分开标记，撤回不触碰记录所有权。
export interface MediaSelection {
  file: File | null; // 本地文件保留到命令结果明确，失败可重新上传。
  mediaId: string | null; // 上传成功后由服务端分配的标识。
  attached: boolean; // 从已有记录取得的附件不能通过取消上传接口删除。
}

// 每条记录至多一张照片和一段录音。
export interface MediaDraft {
  photo: MediaSelection | null; // 当前照片草稿。
  audio: MediaSelection | null; // 当前录音草稿。
}

export type MediaLimits = Pick<components['schemas']['Limits'], 'photo_bytes_max' | 'audio_bytes_max' | 'audio_seconds_max'>;
export type MediaClient = Pick<ApiClient, 'request'>;

// 新增记录没有隐式附件。
export function emptyMediaDraft(): MediaDraft { return { photo: null, audio: null }; }

// 编辑时保留记录已关联的附件，不把它们当作待撤回上传。
export function mediaDraftFromRecord(record: { photo_media_id: string | null; audio_media_id: string | null }): MediaDraft {
  return {
    photo: record.photo_media_id ? { file: null, mediaId: record.photo_media_id, attached: true } : null,
    audio: record.audio_media_id ? { file: null, mediaId: record.audio_media_id, attached: true } : null,
  };
}

// 每项成功都立即回传草稿，后续项失败时重试不会重复上传成功项。
export async function uploadMediaDraft(client: MediaClient, draft: MediaDraft, onUploaded: (draft: MediaDraft) => void): Promise<MediaDraft> {
  let result = draft;
  for (const kind of ['photo', 'audio'] as const) {
    const selection = result[kind];
    if (!selection?.file || selection.mediaId) continue;
    const body = new FormData();
    body.append('kind', kind);
    body.append('file', selection.file);
    const media = await client.request<components['schemas']['Media']>('/media', { method: 'POST', body });
    result = { ...result, [kind]: { ...selection, mediaId: media.id, attached: false } };
    onUploaded(result);
  }
  return result;
}

// 调用方必须传入结果未知命令及当前草稿仍需使用的标识，撤回失败可由过期清理回收。
export async function discardMediaDraft(client: MediaClient, draft: MediaDraft, protectedIds: readonly string[]): Promise<void> {
  const protectedSet = new Set(protectedIds);
  const ids = new Set([draft.photo, draft.audio].flatMap((selection) => selection?.mediaId && !selection.attached && !protectedSet.has(selection.mediaId) ? [selection.mediaId] : []));
  await Promise.all([...ids].map((id) => client.request<void>(`/media/${encodeURIComponent(id)}`, { method: 'DELETE' })));
}

// 私有附件始终经过当前会话读取，组件不接受任意外部预览网址。
export function mediaURL(id: string): string { return `/api/v1/media/${encodeURIComponent(id)}`; }
