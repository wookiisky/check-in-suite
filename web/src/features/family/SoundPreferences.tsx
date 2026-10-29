import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { Preferences, Session } from '../../api/types';
import { Modal } from '../../components/Modal';
import { FormFeedback } from '../../components/FormFeedback';
import { CHECKIN_SUCCESS_EVENT } from '../checkin/events';
import { isRecordingActive, RECORDING_EVENT } from '../media/recordingActivity';
import { SoundEngine } from './sound';
import content from './content.json';
import './family.css';

type PreferenceKey = keyof Preferences;

// 偏好按字段保存，音乐只有当前页面明确用户操作后才播放。
export function SoundPreferences({ client, session, onPreferencesChange, presentation = 'panel', open = false, onClose }: {
  client: Pick<ApiClient, 'request'>; // 已绑定会话的请求入口。
  session: Session; // 当前音效与动效偏好。
  onPreferencesChange: (preferences: Preferences) => void; // 更新共享账户偏好。
  presentation?: 'panel' | 'dialog'; // 普通页面面板与全屏小岛弹层复用同一运行实例。
  open?: boolean; // 弹层是否可见，不影响声音生命周期。
  onClose?: () => void; // 关闭设置但继续运行声音。
}) {
  const [preferences, setPreferences] = useState(session.account.preferences);
  const [busy, setBusy] = useState<PreferenceKey | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [audioError, setAudioError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(isRecordingActive);
  const [systemReduced, setSystemReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const preferencesRef = useRef(preferences);
  const wantedPlayback = useRef(false);
  const recordingRef = useRef(recording);
  const engine = useRef<SoundEngine | null>(null);
  const mounted = useRef(true);
  preferencesRef.current = preferences;
  recordingRef.current = recording;

  useEffect(() => { setPreferences(session.account.preferences); }, [session.account.preferences]);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const change = () => setSystemReduced(media?.matches ?? false);
    media?.addEventListener('change', change);
    return () => media?.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    document.body.dataset.reduceMotion = String(preferences.reduce_motion || systemReduced);
    return () => { delete document.body.dataset.reduceMotion; };
  }, [preferences.reduce_motion, systemReduced]);

  // 录音恢复只依照当前设置；后台返回需要用户再次点播放。
  useEffect(() => {
    mounted.current = true;
    const recordingChanged = () => {
      const active = isRecordingActive(); recordingRef.current = active; setRecording(active);
      if (active) engine.current?.stopMusic();
      else if (wantedPlayback.current && preferencesRef.current.music_enabled && document.visibilityState === 'visible') engine.current?.startMusic();
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') { wantedPlayback.current = false; setPlaying(false); engine.current?.stopMusic(); }
    };
    const success = () => { if (preferencesRef.current.effects_enabled && !recordingRef.current && document.visibilityState === 'visible') engine.current?.success(); };
    const gesture = () => {
      if (!preferencesRef.current.effects_enabled || engine.current) return;
      engine.current = new SoundEngine(); void engine.current.activate();
    };
    window.addEventListener(RECORDING_EVENT, recordingChanged);
    window.addEventListener(CHECKIN_SUCCESS_EVENT, success);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('pointerdown', gesture); document.addEventListener('keydown', gesture);
    return () => {
      mounted.current = false;
      window.removeEventListener(RECORDING_EVENT, recordingChanged); window.removeEventListener(CHECKIN_SUCCESS_EVENT, success); document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('pointerdown', gesture); document.removeEventListener('keydown', gesture);
      engine.current?.dispose(); engine.current = null;
    };
  }, []);

  // 在按钮事件中激活音频，避免网络响应后才尝试取得播放权限。
  async function startMusic() {
    engine.current ??= new SoundEngine();
    const active = await engine.current.activate();
    if (!mounted.current) return;
    if (!active) { setAudioError(content.audioUnavailable); return; }
    setAudioError(''); wantedPlayback.current = true; setPlaying(true);
    if (!recordingRef.current && document.visibilityState === 'visible') engine.current.startMusic();
  }
  async function change(key: PreferenceKey, value: boolean) {
    setBusy(key); setError(null);
    if (key === 'music_enabled') {
      if (value) void startMusic();
      else { wantedPlayback.current = false; setPlaying(false); engine.current?.stopMusic(); }
    } else if (key === 'effects_enabled' && value) { engine.current ??= new SoundEngine(); void engine.current.activate(); }
    try {
      const saved = await client.request<Preferences>('/account/preferences', { method: 'PATCH', body: { [key]: value } });
      if (!mounted.current) return;
      const next = { ...preferencesRef.current, [key]: saved[key] };
      preferencesRef.current = next; setPreferences(next); onPreferencesChange(next);
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason);
      if (key === 'music_enabled' && value) { wantedPlayback.current = false; setPlaying(false); engine.current?.stopMusic(); }
    } finally { if (mounted.current) setBusy(null); }
  }
  const controls = <section className={presentation === 'panel' ? 'panel family-sound-panel' : 'family-sound-dialog'}>{presentation === 'panel' && <h2>{content.sounds}</h2>}<div className="family-preferences">{(['music_enabled', 'effects_enabled', 'reduce_motion'] as const).map((key) => <label key={key}><input type="checkbox" checked={preferences[key]} disabled={busy !== null} onChange={(event) => void change(key, event.target.checked)} />{key === 'music_enabled' ? content.music : key === 'effects_enabled' ? content.effects : content.reduceMotion}</label>)}</div>
    {preferences.music_enabled && <><p className="muted">{recording ? content.recordingPaused : !playing ? content.musicNeedsGesture : ''}</p><button className="secondary" onClick={() => { if (playing) { wantedPlayback.current = false; setPlaying(false); engine.current?.stopMusic(); } else void startMusic(); }}>{playing ? content.pauseMusic : content.playMusic}</button></>}
    {systemReduced && <p className="muted">{content.systemReduced}</p>}{audioError && <p role="alert" className="form-error">{audioError}</p>}<FormFeedback error={error} />
  </section>;
  if (presentation === 'dialog') return open ? <Modal title={content.sounds} onClose={() => onClose?.()}>{controls}</Modal> : null;
  return controls;
}
