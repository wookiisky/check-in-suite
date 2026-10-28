import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../api/client';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import type { MediaDraft } from '../media/media-draft';
import { CheckinComposer } from './CheckinComposer';
import { recordFixture, taskFixture } from './test-fixtures';
import content from './content.json';

// 这里只替代设备采集，上传仍通过实际FormData与请求编排验证。
vi.mock('../media/MediaEditor', () => ({ MediaEditor: ({ value, onChange }: { value: MediaDraft; onChange: (draft: MediaDraft) => void }) => <div>
  <button type="button" onClick={() => onChange({ ...value, photo: { file: new File(['photo'], 'photo.png', { type: 'image/png' }), mediaId: null, attached: false } })}>select-photo</button>
  <button type="button" onClick={() => onChange({ ...value, audio: { file: new File(['audio'], 'audio.webm', { type: 'audio/webm' }), mediaId: null, attached: false } })}>select-audio</button>
  <button type="button" onClick={() => onChange({ ...value, photo: null })}>remove-photo</button>
</div> }));

const session = testSession as Session;
const result = { checkin: { ...recordFixture, photo_media_id: 'photo-ready', audio_media_id: 'audio-ready' }, wallet: { coins: 2, diamonds: 1, version: 2 }, task_remaining: 1, today: session.today };
const lost = () => new ApiFailure(0, { code: 'NETWORK_ERROR', field_errors: {}, request_id: '' });

describe('记录附件与未知结果', () => {
  it('部分上传失败只重试失败附件，全部成功后才提交媒体ID', async () => {
    let audioAttempts = 0;
    const uploads: string[] = [];
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
      if (path === '/media') {
        expect(options?.body).toBeInstanceOf(FormData);
        const kind = String((options?.body as FormData).get('kind'));
        uploads.push(kind);
        if (kind === 'audio' && audioAttempts++ === 0) throw lost();
        return { id: `${kind}-ready` };
      }
      return result;
    });
    render(<CheckinComposer client={{ request }} session={session} task={taskFixture} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'select-photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'select-audio' }));
    fireEvent.click(screen.getByRole('button', { name: content.checkin }));
    await screen.findByRole('alert');
    expect(request.mock.calls.filter((call) => call[0] === '/checkins')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: content.checkin }));
    await waitFor(() => expect(request.mock.calls.filter((call) => call[0] === '/checkins')).toHaveLength(1));
    expect(uploads).toEqual(['photo', 'audio', 'audio']);
    expect(request.mock.calls.find((call) => call[0] === '/checkins')?.[1].body).toMatchObject({ photo_media_id: 'photo-ready', audio_media_id: 'audio-ready' });
  });

  it('未知原提交的媒体不能因移除草稿而撤回，核对成功后改为编辑', async () => {
    let creates = 0;
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === '/media') return { id: 'photo-ready' };
      if (path === '/checkins') { creates++; if (creates === 1) throw lost(); return { ...result, checkin: { ...recordFixture, text: '', photo_media_id: 'photo-ready' } }; }
      if (options?.method === 'PATCH') return { ...recordFixture, text: '', photo_media_id: null, version: 2 };
      return undefined;
    });
    render(<CheckinComposer client={{ request }} session={session} task={taskFixture} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'select-photo' }));
    fireEvent.click(screen.getByRole('button', { name: content.checkin }));
    await screen.findByText(content.unknownResult);
    fireEvent.click(screen.getByRole('button', { name: 'remove-photo' }));
    expect(request.mock.calls.filter((call) => call[1]?.method === 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: content.recover }));
    await screen.findByText(content.resolvedEdit);
    const commands = request.mock.calls.filter((call) => call[0] === '/checkins');
    expect(commands[0]).toEqual(commands[1]);
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/checkins/record-1', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ photo_media_id: null }) })));
    expect(creates).toBe(2);
  });

  it('放弃编辑只撤回新上传的未关联附件，保留原已关联照片', async () => {
    const request = vi.fn().mockImplementation(async (path: string, options?: { body?: unknown }) => {
      if (path === '/media') {
        if ((options?.body as FormData).get('kind') === 'audio') throw lost();
        return { id: 'new-ready' };
      }
      return undefined;
    });
    render(<CheckinComposer client={{ request }} session={session} task={taskFixture} record={{ ...recordFixture, photo_media_id: 'attached-old' }} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'select-photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'select-audio' }));
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: content.close }));
    fireEvent.click(screen.getByRole('button', { name: content.discard }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/media/new-ready', { method: 'DELETE' }));
    expect(request.mock.calls.some((call) => call[0] === '/media/attached-old')).toBe(false);
  });

  it('未知编辑关闭后仍重放原PATCH，版本冲突通过读取核对，再处理新草稿', async () => {
    let patches = 0;
    const originalRecord = { ...recordFixture, text: '' };
    const updated = { ...originalRecord, photo_media_id: 'photo-ready', version: 2 };
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === '/media') return { id: 'photo-ready' };
      if (options?.method === 'PATCH') {
        patches++;
        if (patches === 1) throw lost();
        if (patches === 2) throw new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' });
        return { ...updated, photo_media_id: null, version: 3 };
      }
      if (path.startsWith('/checkins?')) return { items: [updated], next_cursor: null };
      return undefined;
    });
    const client = { request };
    const first = render(<CheckinComposer client={client} session={session} task={taskFixture} record={originalRecord} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'select-photo' }));
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByRole('button', { name: content.recover });
    fireEvent.click(screen.getByRole('button', { name: 'remove-photo' }));
    fireEvent.click(screen.getByRole('button', { name: content.close }));
    first.unmount();
    render(<CheckinComposer client={client} session={session} task={taskFixture} record={originalRecord} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: content.recover }));
    await screen.findByRole('button', { name: content.save });
    const commands = request.mock.calls.filter((call) => call[1]?.method === 'PATCH');
    expect(commands[0]).toEqual(commands[1]);
    expect(request.mock.calls.filter((call) => call[1]?.method === 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(patches).toBe(3));
    expect(request.mock.calls.filter((call) => call[1]?.method === 'PATCH')[2]?.[1].body).toMatchObject({ expected_version: 2, photo_media_id: null });
  });
});

describe('附件授权失效与跨日恢复', () => {
  it('第二附件上传遇401后重开，保留文字、文件和第一附件ID', async () => {
    let audioAttempts = 0;
    const uploads: string[] = [];
    const request = vi.fn().mockImplementation(async (path: string, options?: { body?: unknown }) => {
      if (path === '/media') {
        const kind = String((options?.body as FormData).get('kind')); uploads.push(kind);
        if (kind === 'audio' && audioAttempts++ === 0) throw new ApiFailure(401, { code: 'SESSION_REQUIRED', field_errors: {}, request_id: '' });
        return { id: `${kind}-ready` };
      }
      return result;
    });
    const client = { request };
    const first = render(<CheckinComposer client={client} session={session} task={taskFixture} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.text), { target: { value: '授权恢复后继续' } });
    fireEvent.click(screen.getByRole('button', { name: 'select-photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'select-audio' }));
    fireEvent.click(screen.getByRole('button', { name: content.checkin }));
    await screen.findByRole('alert');
    first.unmount();
    render(<CheckinComposer client={client} session={session} task={taskFixture} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(content.text)).toHaveValue('授权恢复后继续');
    expect(screen.queryByRole('button', { name: content.recover })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.checkin }));
    await waitFor(() => expect(request.mock.calls.filter((call) => call[0] === '/checkins')).toHaveLength(1));
    expect(uploads).toEqual(['photo', 'audio', 'audio']);
  });

  it('原编辑跨日已成功时读取确认，不能永久重复普通历史PATCH', async () => {
    let patches = 0;
    const updated = { ...recordFixture, text: '跨日前保存', version: 2, can_edit: false, can_delete: false };
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'PATCH') {
        patches++;
        if (patches === 1) throw lost();
        throw new ApiFailure(403, { code: 'HISTORY_READ_ONLY', field_errors: {}, request_id: '' });
      }
      if (path.startsWith('/checkins?')) return { items: [updated], next_cursor: null };
      return undefined;
    });
    const saved = vi.fn();
    render(<CheckinComposer client={{ request }} session={session} task={taskFixture} record={recordFixture} date={session.today} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.change(screen.getByLabelText(content.text), { target: { value: updated.text } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByRole('button', { name: content.recover });
    fireEvent.click(screen.getByRole('button', { name: content.recover }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(content.saved, updated));
    expect(patches).toBe(2);
  });

  it('原编辑跨日未应用时保留草稿，管理重开后使用管理路径重新确认', async () => {
    let ordinaryPatches = 0;
    const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string; body?: { text?: string } }) => {
      if (path === '/checkins/record-1' && options?.method === 'PATCH') {
        ordinaryPatches++;
        if (ordinaryPatches === 1) throw lost();
        throw new ApiFailure(403, { code: 'HISTORY_READ_ONLY', field_errors: {}, request_id: '' });
      }
      if (path.startsWith('/checkins?')) return { items: [{ ...recordFixture, can_edit: false, can_delete: false }], next_cursor: null };
      if (path === '/management/checkins/record-1') return { ...recordFixture, text: options?.body?.text, version: 2 };
      return undefined;
    });
    const client = { request };
    const first = render(<CheckinComposer client={client} session={session} task={taskFixture} record={recordFixture} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(content.text), { target: { value: '保留到管理页的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByRole('button', { name: content.recover });
    fireEvent.click(screen.getByRole('button', { name: content.recover }));
    await waitFor(() => expect(screen.getByRole('button', { name: content.save })).toBeDisabled());
    first.unmount();
    render(<CheckinComposer client={client} session={session} task={taskFixture} record={recordFixture} date={session.today} management onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(content.text)).toHaveValue('保留到管理页的草稿');
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/management/checkins/record-1', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ text: '保留到管理页的草稿' }) })));
    expect(ordinaryPatches).toBe(2);
  });
});

it('过期附件先核对原提交，得到明确失败后才重新上传并生成新命令', async () => {
  let uploads = 0;
  let creates = 0;
  const request = vi.fn().mockImplementation(async (path: string) => {
    if (path === '/media') return { id: uploads++ === 0 ? 'photo-expired' : 'photo-new' };
    if (path === '/checkins') {
      creates++;
      if (creates === 1) throw lost();
      if (creates === 2) throw new ApiFailure(422, { code: 'INVALID_MEDIA', field_errors: {}, request_id: '' });
      return { ...result, checkin: { ...recordFixture, photo_media_id: 'photo-new', audio_media_id: null } };
    }
    return undefined;
  });
  render(<CheckinComposer client={{ request }} session={session} task={taskFixture} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'select-photo' }));
  fireEvent.click(screen.getByRole('button', { name: content.checkin }));
  await screen.findByRole('button', { name: content.recover });
  fireEvent.click(screen.getByRole('button', { name: content.recover }));
  await screen.findByText(content.mediaRenewed);
  expect(uploads).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: content.checkin }));
  await waitFor(() => expect(creates).toBe(3));
  expect(uploads).toBe(2);
  const commands = request.mock.calls.filter((call) => call[0] === '/checkins');
  expect(commands[0]).toEqual(commands[1]);
  expect(commands[2]?.[1].body.photo_media_id).toBe('photo-new');
  expect(commands[2]?.[1].idempotencyKey).not.toBe(commands[0]?.[1].idempotencyKey);
});

it('上传401保留的新建草稿不会被另一条已有记录的编辑删除', async () => {
  let audioAttempts = 0;
  const uploadedKinds: string[] = [];
  const request = vi.fn().mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (path === '/media') {
      const kind = String((options?.body as FormData).get('kind')); uploadedKinds.push(kind);
      if (kind === 'audio' && audioAttempts++ === 0) throw new ApiFailure(401, { code: 'SESSION_REQUIRED', field_errors: {}, request_id: '' });
      return { id: `${kind}-ready` };
    }
    if (options?.method === 'PATCH') return { ...recordFixture, text: '旧记录 B 的修改', version: 2 };
    return result;
  });
  const client = { request };
  const first = render(<CheckinComposer client={client} session={session} task={taskFixture} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(content.text), { target: { value: '新建草稿 A' } });
  fireEvent.click(screen.getByRole('button', { name: 'select-photo' }));
  fireEvent.click(screen.getByRole('button', { name: 'select-audio' }));
  fireEvent.click(screen.getByRole('button', { name: content.checkin }));
  await screen.findByRole('alert');
  first.unmount();

  const second = render(<CheckinComposer client={client} session={session} task={taskFixture} record={recordFixture} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(content.text), { target: { value: '旧记录 B 的修改' } });
  fireEvent.click(screen.getByRole('button', { name: content.save }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/checkins/record-1', expect.objectContaining({ method: 'PATCH' })));
  second.unmount();

  render(<CheckinComposer client={client} session={session} task={taskFixture} date={session.today} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByLabelText(content.text)).toHaveValue('新建草稿 A');
  fireEvent.click(screen.getByRole('button', { name: content.checkin }));
  await waitFor(() => expect(request.mock.calls.filter((call) => call[0] === '/checkins')).toHaveLength(1));
  expect(uploadedKinds).toEqual(['photo', 'audio', 'audio']);
});
