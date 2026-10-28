import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { setRecordingActive } from '../media/recordingActivity';
import { CHECKIN_SUCCESS_EVENT } from '../checkin/events';
import { SoundPreferences } from './SoundPreferences';

const sound = vi.hoisted(() => ({ activate: vi.fn(async () => true), start: vi.fn(), stop: vi.fn(), success: vi.fn(), dispose: vi.fn() }));
vi.mock('./sound', () => ({ SoundEngine: class {
  activate = sound.activate; startMusic = sound.start; stopMusic = sound.stop; success = sound.success; dispose = sound.dispose;
} }));
const session: Session = { ...testSession, timezone: 'Asia/Taipei' };
beforeEach(() => vi.clearAllMocks());
afterEach(() => { setRecordingActive(false); });

describe('录音与音乐联动', () => {
  it('保存过开启偏好也不自动播，用户播放后录音暂停并恢复，关闭后不恢复', async () => {
    const enabled = { ...session, account: { ...session.account, preferences: { ...session.account.preferences, music_enabled: true } } };
    const request = vi.fn().mockResolvedValue({ ...session.account.preferences, music_enabled: false });
    const view = render(<SoundPreferences client={{ request }} session={enabled} onPreferencesChange={() => {}} />);
    expect(sound.activate).not.toHaveBeenCalled(); expect(sound.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '播放背景音乐' }));
    await waitFor(() => expect(sound.start).toHaveBeenCalledTimes(1));
    act(() => setRecordingActive(true)); expect(sound.stop).toHaveBeenCalled();
    act(() => setRecordingActive(false)); expect(sound.start).toHaveBeenCalledTimes(2);
    act(() => setRecordingActive(true));
    fireEvent.click(screen.getByLabelText('背景音乐'));
    await waitFor(() => expect(screen.getByLabelText('背景音乐')).not.toBeChecked());
    act(() => setRecordingActive(false)); expect(sound.start).toHaveBeenCalledTimes(2);
    view.unmount(); expect(sound.dispose).toHaveBeenCalled();
  });

  it('音效在用户手势后可用，关闭偏好后成功事件仍不发声', async () => {
    const request = vi.fn().mockResolvedValue({ ...session.account.preferences, effects_enabled: false });
    render(<SoundPreferences client={{ request }} session={session} onPreferencesChange={() => {}} />);
    expect(sound.activate).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(sound.activate).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new CustomEvent(CHECKIN_SUCCESS_EVENT, { detail: 'record' })));
    expect(sound.success).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('操作音效'));
    await waitFor(() => expect(screen.getByLabelText('操作音效')).not.toBeChecked());
    act(() => window.dispatchEvent(new CustomEvent(CHECKIN_SUCCESS_EVENT, { detail: 'record2' })));
    expect(sound.success).toHaveBeenCalledTimes(1);
  });

  it('减少动效写入指定字段并作用于页面', async () => {
    const request = vi.fn().mockResolvedValue({ ...session.account.preferences, reduce_motion: true });
    const view = render(<SoundPreferences client={{ request }} session={session} onPreferencesChange={() => {}} />);
    fireEvent.click(screen.getByLabelText('减少动效'));
    await waitFor(() => expect(document.body.dataset.reduceMotion).toBe('true'));
    expect(request).toHaveBeenCalledWith('/account/preferences', { method: 'PATCH', body: { reduce_motion: true } });
    view.unmount(); expect(document.body.dataset.reduceMotion).toBeUndefined();
  });
});

it('离开页面后迟到的偏好响应不更新新页面账户', async () => {
  let resolve!: (value: unknown) => void;
  const request = vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; }));
  const changed = vi.fn();
  const view = render(<SoundPreferences client={{ request }} session={session} onPreferencesChange={changed} />);
  fireEvent.click(screen.getByLabelText('减少动效'));
  view.unmount();
  await act(async () => { resolve({ ...session.account.preferences, reduce_motion: true }); });
  expect(changed).not.toHaveBeenCalled();
});
