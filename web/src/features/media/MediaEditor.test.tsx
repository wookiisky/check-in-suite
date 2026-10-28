import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaEditor } from './MediaEditor';
import { emptyMediaDraft } from './media-draft';
import type { MediaDraft } from './media-draft';
import { FakeAudioTrack, FakeMediaRecorder } from './media-test-fakes';
import content from './content.json';

const limits = { photo_bytes_max: 1024, audio_bytes_max: 1024, audio_seconds_max: 60 };
let changed = vi.fn<(draft: MediaDraft) => void>();
let track: FakeAudioTrack;

// 用受控父级证明照片和录音修改不会覆盖另一种附件。
function Harness() { const [draft, setDraft] = useState<MediaDraft>(emptyMediaDraft()); return <MediaEditor value={draft} limits={limits} onChange={(next) => { setDraft(next); changed(next); }} />; }

beforeEach(() => {
  changed = vi.fn<(draft: MediaDraft) => void>(); track = new FakeAudioTrack();
  FakeMediaRecorder.instances = []; FakeMediaRecorder.supported = true;
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) } });
  URL.createObjectURL = vi.fn(() => 'blob:media-preview'); URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('照片与录音编辑', () => {
  it('照片替换与移除释放预览URL，非法文件保留原照片', async () => {
    const { unmount } = render(<Harness />);
    const picker = screen.getByLabelText(content.choosePhoto);
    fireEvent.change(picker, { target: { files: [new File(['png'], 'photo.png', { type: 'image/png' })] } });
    await screen.findByAltText(content.photoPreview);
    fireEvent.change(picker, { target: { files: [new File(['heic'], 'photo.heic', { type: 'image/heic' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent(content.errors.photoType);
    expect(changed).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: content.removePhoto }));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:media-preview'));
    unmount();
  });
  it('录音停止进入试听，明确选择后才替换草稿', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: content.startRecording }));
    await screen.findByRole('button', { name: content.stopRecording });
    fireEvent.click(screen.getByRole('button', { name: content.stopRecording }));
    await screen.findByLabelText(content.audioPreview);
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: content.useRecording }));
    expect(changed.mock.lastCall?.[0].audio?.file).toBeInstanceOf(File);
    expect(screen.getByText(content.selected)).toBeInTheDocument();
  });
  it('组件关闭时停止正在采集的音轨并通知声音恢复', async () => {
    const activity = vi.fn(); const { unmount } = render(<MediaEditor value={emptyMediaDraft()} onChange={changed} limits={limits} onRecordingChange={activity} />);
    fireEvent.click(screen.getByRole('button', { name: content.startRecording }));
    await screen.findByRole('button', { name: content.stopRecording });
    act(() => unmount());
    expect(track.stop).toHaveBeenCalled(); expect(activity).toHaveBeenLastCalledWith(false);
  });
});
