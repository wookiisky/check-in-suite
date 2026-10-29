import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { setRecordingActive } from '../media/recordingActivity';
import { CHECKIN_SUCCESS_EVENT } from '../checkin/events';
import { SoundPreferences } from './SoundPreferences';
import content from './content.json';
import { dispatchFeedback } from '../../feedback/feedback-events';
import { sound } from './sound-preferences-test-fakes';

vi.mock('./sound', async () => ({ SoundEngine: (await import('./sound-preferences-test-fakes')).SoundEngineFake }));
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
    act(() => window.dispatchEvent(new CustomEvent(CHECKIN_SUCCESS_EVENT, { detail: { recordId: 'record', coins: 7, diamonds: 3 } })));
    expect(sound.success).toHaveBeenCalledExactlyOnceWith(7, 3);
    fireEvent.click(screen.getByLabelText('操作音效'));
    await waitFor(() => expect(screen.getByLabelText('操作音效')).not.toBeChecked());
    act(() => window.dispatchEvent(new CustomEvent(CHECKIN_SUCCESS_EVENT, { detail: { recordId: 'record2', coins: 50, diamonds: 50 } })));
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


it('全屏设置关闭和切换展示方式不重建声音运行实例', async () => {
  const request = vi.fn();
  const props = { client: { request }, session, onPreferencesChange: vi.fn() };
  const view = render(<SoundPreferences {...props} />);
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(sound.activate).toHaveBeenCalledTimes(1));
  view.rerender(<SoundPreferences {...props} presentation="dialog" open={false} onClose={() => {}} />);
  expect(screen.queryByRole('heading', { name: content.sounds })).not.toBeInTheDocument();
  expect(sound.dispose).not.toHaveBeenCalled();
  view.rerender(<SoundPreferences {...props} presentation="dialog" open onClose={() => {}} />);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  view.rerender(<SoundPreferences {...props} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(sound.activate).toHaveBeenCalledTimes(1);
  expect(sound.dispose).not.toHaveBeenCalled();
  view.unmount();
  expect(sound.dispose).toHaveBeenCalledTimes(1);
});


describe('业务反馈的声音边界', () => {
  it('购买、换装、保存仅在激活后播放，减少动效不会关闭音效', async () => {
    const reduced = { ...session, account: { ...session.account, preferences: { ...session.account.preferences, reduce_motion: true } } };
    render(<SoundPreferences client={{ request: vi.fn() }} session={reduced} onPreferencesChange={() => {}} />);
    act(() => dispatchFeedback('purchase'));
    expect(sound.feedback).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect(sound.activate).toHaveBeenCalledTimes(1));
    for (const kind of ['purchase', 'equip', 'island-save'] as const) act(() => dispatchFeedback(kind));
    expect(sound.feedback.mock.calls.map(([kind]) => kind)).toEqual(['purchase', 'equip', 'island-save']);
    act(() => window.dispatchEvent(new CustomEvent(CHECKIN_SUCCESS_EVENT, { detail: { recordId: 'reduced', coins: 2, diamonds: 1 } })));
    expect(sound.success).toHaveBeenCalledExactlyOnceWith(2, 1);
    act(() => setRecordingActive(true));
    act(() => dispatchFeedback('purchase'));
    act(() => window.dispatchEvent(new CustomEvent(CHECKIN_SUCCESS_EVENT, { detail: { recordId: 'recording', coins: 2, diamonds: 1 } })));
    expect(sound.success).toHaveBeenCalledTimes(1);
    expect(sound.feedback).toHaveBeenCalledTimes(3);
    expect(sound.stop).toHaveBeenCalled();
    act(() => setRecordingActive(false));
    act(() => dispatchFeedback('equip'));
    expect(sound.feedback).toHaveBeenCalledTimes(4);
  });

  it('隐藏页面停止声音并忽略所有反馈，回来后不重播', async () => {
    render(<SoundPreferences client={{ request: vi.fn() }} session={session} onPreferencesChange={() => {}} />);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(sound.activate).toHaveBeenCalledTimes(1));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(sound.stop).toHaveBeenCalled();
    act(() => dispatchFeedback('purchase'));
    act(() => window.dispatchEvent(new CustomEvent(CHECKIN_SUCCESS_EVENT)));
    expect(sound.feedback).not.toHaveBeenCalled();
    expect(sound.success).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(sound.feedback).not.toHaveBeenCalled();
    expect(sound.start).not.toHaveBeenCalled();
  });

  it('点击关闭音效立即停止短音，偏好保存期间也不播放', async () => {
    let complete!: (value: unknown) => void;
    const request = vi.fn().mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    render(<SoundPreferences client={{ request }} session={session} onPreferencesChange={() => {}} />);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(sound.activate).toHaveBeenCalledTimes(1));
    act(() => dispatchFeedback('equip'));
    fireEvent.click(screen.getByLabelText(content.effects));
    expect(sound.stopEffects).toHaveBeenCalledTimes(1);
    act(() => dispatchFeedback('purchase'));
    expect(sound.feedback).toHaveBeenCalledTimes(1);
    await act(async () => complete({ ...session.account.preferences, effects_enabled: false }));
    act(() => dispatchFeedback('island-save'));
    expect(sound.feedback).toHaveBeenCalledTimes(1);
  });

  it('音频激活失败后下一次用户手势会重试，同一时刻只激活一次', async () => {
    sound.activate.mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<SoundPreferences client={{ request: vi.fn() }} session={session} onPreferencesChange={() => {}} />);
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect(sound.activate).toHaveBeenCalledTimes(1));
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(sound.activate).toHaveBeenCalledTimes(2));
    fireEvent.pointerDown(document.body);
    expect(sound.activate).toHaveBeenCalledTimes(2);
  });

  it('关闭音效保存失败后保留原偏好，之后的成功操作仍可发声', async () => {
    const request = vi.fn().mockRejectedValue(new Error('offline'));
    render(<SoundPreferences client={{ request }} session={session} onPreferencesChange={() => {}} />);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(sound.activate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText(content.effects));
    expect(sound.stopEffects).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText(content.effects)).toBeEnabled());
    expect(screen.getByLabelText(content.effects)).toBeChecked();
    act(() => dispatchFeedback('purchase'));
    expect(sound.feedback).toHaveBeenCalledWith('purchase');
  });
});
