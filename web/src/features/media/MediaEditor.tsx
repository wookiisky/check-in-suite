import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { AudioCapture } from './audio-capture';
import type { CaptureError, CaptureState } from './audio-capture';
import { mediaURL } from './media-draft';
import type { MediaDraft, MediaLimits, MediaSelection } from './media-draft';
import content from './content.json';
import './media.css';

// 草稿由打卡表单持有，组件卸载只释放采集与预览，不撤回未知命令的附件。
interface MediaEditorProps {
  value: MediaDraft; // 当前照片与录音。
  onChange: (draft: MediaDraft) => void; // 调用方负责保护在途媒体并撤回放弃的临时上传。
  limits: MediaLimits; // 服务端会话公布的附件限制。
  disabled?: boolean; // 提交期间阻止替换附件。
  onRecordingChange?: (recording: boolean) => void; // 让表单在采集期间禁止提交。
}

// 本地预览的对象URL与组件生命周期绑定，File本身可继续留在草稿中。
function usePreview(selection: MediaSelection | null): string | null {
  const [localURL, setLocalURL] = useState<string | null>(null);
  const file = selection?.file ?? null;
  useEffect(() => {
    if (!file) { setLocalURL(null); return; }
    const url = URL.createObjectURL(file); setLocalURL(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return file ? localURL : selection?.mediaId ? mediaURL(selection.mediaId) : null;
}

// 真实采集提供明确试听与选择步骤，错误不清空其它附件或文字。
export function MediaEditor({ value, onChange, limits, disabled = false, onRecordingChange }: MediaEditorProps) {
  const [captureState, setCaptureState] = useState<CaptureState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [candidate, setCandidate] = useState<File | null>(null);
  const [audioError, setAudioError] = useState<CaptureError | null>(null);
  const [photoError, setPhotoError] = useState<'photoType' | 'photoSize' | 'photoPreview' | null>(null);
  const capture = useRef<AudioCapture | null>(null);
  const activityCallback = useRef(onRecordingChange); activityCallback.current = onRecordingChange;
  const camera = useRef<HTMLInputElement>(null);
  const photoPicker = useRef<HTMLInputElement>(null);
  const photoURL = usePreview(value.photo);
  const audioSelection = candidate ? { file: candidate, mediaId: null, attached: false } : value.audio;
  const audioURL = usePreview(audioSelection);
  const recording = ['requesting', 'recording', 'stopping'].includes(captureState);

  useEffect(() => {
    const controller = new AudioCapture({
      onState: (state) => { setCaptureState(state); activityCallback.current?.(['requesting', 'recording', 'stopping'].includes(state)); },
      onFile: setCandidate,
      onError: setAudioError,
      onTime: setSeconds,
    }, { audio_bytes_max: limits.audio_bytes_max, audio_seconds_max: limits.audio_seconds_max });
    capture.current = controller;
    return () => { controller.dispose(); activityCallback.current?.(false); };
  }, [limits.audio_bytes_max, limits.audio_seconds_max]);

  // 本地类型和大小检查仅用于即时反馈，服务端仍检查真实内容。
  function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type) && !(file.type === '' && /\.(jpe?g|png)$/i.test(file.name))) { setPhotoError('photoType'); return; }
    if (file.size === 0 || file.size > limits.photo_bytes_max) { setPhotoError('photoSize'); return; }
    setPhotoError(null); onChange({ ...value, photo: { file, mediaId: null, attached: false } });
  }

  // 重录保留原已选择录音，只有显式选用新录音才替换。
  function startRecording() { setAudioError(null); setCandidate(null); setSeconds(0); void capture.current?.start(); }

  return <div className="media-editor">
    <fieldset disabled={disabled} className="media-section">
      <legend><img className="media-legend-icon" src="/api/v1/assets/camera-v1" alt="" aria-hidden="true" /><span>{content.photos}</span></legend>
      <div className="media-actions">
        <button type="button" className="secondary" onClick={() => camera.current?.click()}>{content.takePhoto}</button>
        <button type="button" className="secondary" onClick={() => photoPicker.current?.click()}>{content.choosePhoto}</button>
        <input ref={camera} type="file" accept="image/jpeg,image/png" capture="environment" hidden aria-label={content.takePhoto} onChange={choosePhoto} />
        <input ref={photoPicker} type="file" accept="image/jpeg,image/png" hidden aria-label={content.choosePhoto} onChange={choosePhoto} />
      </div>
      {photoURL && <img className="media-photo" src={photoURL} alt={content.photoPreview} onError={() => setPhotoError('photoPreview')} />}
      {value.photo && <button type="button" className="secondary" onClick={() => { setPhotoError(null); onChange({ ...value, photo: null }); }}>{content.removePhoto}</button>}
      {photoError && <p className="media-error" role="alert">{content.errors[photoError]}</p>}
    </fieldset>
    <fieldset disabled={disabled} className="media-section">
      <legend><img className="media-legend-icon" src="/api/v1/assets/mic-v1" alt="" aria-hidden="true" /><span>{content.audio}</span></legend>
      {captureState === 'requesting' && <p role="status">{content.requesting}</p>}
      {captureState === 'recording' && <p role="status">{content.recording} {seconds} / {limits.audio_seconds_max} {content.seconds}</p>}
      {captureState === 'stopping' && <p role="status">{content.stopping}</p>}
      <div className="media-actions">
        {captureState === 'recording' ? <button type="button" onClick={() => capture.current?.stop()}>{content.stopRecording}</button> : <button type="button" className="secondary" disabled={recording} onClick={startRecording}>{value.audio || candidate ? content.recordAgain : content.startRecording}</button>}
      </div>
      {!recording && audioURL && <audio controls preload="metadata" src={audioURL} aria-label={content.audioPreview} />}
      {!recording && candidate && <div className="media-actions"><button type="button" onClick={() => { onChange({ ...value, audio: { file: candidate, mediaId: null, attached: false } }); setCandidate(null); }}>{content.useRecording}</button><button type="button" className="secondary" onClick={() => setCandidate(null)}>{content.discardRecording}</button></div>}
      {!recording && !candidate && value.audio && <button type="button" className="secondary" onClick={() => { setAudioError(null); onChange({ ...value, audio: null }); }}>{content.removeAudio}</button>}
      {audioError && <p className="media-error" role="alert">{content.errors[audioError]}</p>}
    </fieldset>
  </div>;
}
