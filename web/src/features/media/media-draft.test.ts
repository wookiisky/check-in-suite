import { describe, expect, it, vi } from 'vitest';
import { discardMediaDraft, emptyMediaDraft, mediaDraftFromRecord, uploadMediaDraft } from './media-draft';

describe('媒体草稿上传和撤回', () => {
  it('保留部分成功的上传，重试只上传失败的音频', async () => {
    let draft = { photo: { file: new File(['photo'], 'photo.png', { type: 'image/png' }), mediaId: null, attached: false }, audio: { file: new File(['audio'], 'audio.webm', { type: 'audio/webm' }), mediaId: null, attached: false } } as ReturnType<typeof emptyMediaDraft>;
    const request = vi.fn().mockResolvedValueOnce({ id: 'photo-id' }).mockRejectedValueOnce(new Error('upload failed')).mockResolvedValueOnce({ id: 'audio-id' });
    await expect(uploadMediaDraft({ request }, draft, (next) => { draft = next; })).rejects.toThrow();
    expect(draft.photo?.mediaId).toBe('photo-id');
    expect(draft.audio?.mediaId).toBeNull();
    const result = await uploadMediaDraft({ request }, draft, (next) => { draft = next; });
    expect(result.audio?.mediaId).toBe('audio-id');
    expect(request).toHaveBeenCalledTimes(3);
    expect((request.mock.calls[2]?.[1].body as FormData).get('kind')).toBe('audio');
  });

  it('不撤回已关联附件或结果未知命令持有的附件', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const existing = mediaDraftFromRecord({ photo_media_id: 'attached', audio_media_id: null });
    await discardMediaDraft({ request }, existing, []);
    await discardMediaDraft({ request }, { photo: { file: null, mediaId: 'protected', attached: false }, audio: { file: null, mediaId: 'unused', attached: false } }, ['protected']);
    expect(request).toHaveBeenCalledExactlyOnceWith('/media/unused', { method: 'DELETE' });
  });
});
