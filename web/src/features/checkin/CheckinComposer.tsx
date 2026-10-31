import { CurrencyAmount } from '../../components/CurrencyAmount';
import { useWalletSync } from '../../components/WalletContext';
import { useId, useRef, useState } from 'react';
import { ApiFailure } from '../../api/client';
import { Modal } from '../../components/Modal';
import { FieldError } from '../../components/FormFeedback';
import type { Session } from '../../api/types';
import { MediaEditor } from '../media/MediaEditor';
import { discardMediaDraft, emptyMediaDraft, mediaDraftFromRecord, uploadMediaDraft } from '../media/media-draft';
import type { MediaDraft } from '../media/media-draft';
import type { Checkin, CheckinClient, Task } from './types';
import { createPendingCheckin, getPending, rememberPending, replayCheckin } from './submission';
import type { PendingCheckin } from './submission';
import { draftMediaIDs, getPendingEdit, markAttached, mediaMatches, rememberEdit, renewUnavailableMedia, replayEdit } from './media-submission';
import type { PendingEdit } from './media-submission';
import { checkinError, isDefiniteFailure } from './format';
import { readCurrentRecord } from './records';
import { TaskIcon } from './TaskIcon';
import { CREATE_DRAFT_KEY, getDraft, rememberDraft } from './drafts';
import content from './content.json';

/** 编辑与新增共用内容表单，但原日期、任务和奖励不可编辑。 */
interface ComposerProps {
  client: CheckinClient; // 当前会话请求客户端。
  session: Session; // 当前生效的输入限制。
  task: Task; // 新增时确认的任务快照。
  date: string; // 用户明确选择的所属日期。
  management?: boolean; // 只由管理页面传入，服务端仍独立授权。
  record?: Checkin; // 内容编辑目标。
  initialText?: string; // 纠正流程带入的草稿。
  onClose: () => void; // 关闭弹窗，未知命令仍保留。
  onSaved: (message: string, record?: Checkin, created?: boolean) => void; // 成功后只触发读取刷新。
}

/** 原请求与可编辑草稿分开保存，先确定原提交，再处理文字或附件差异。 */
export function CheckinComposer({ client, session, task, date, management = false, record, initialText, onClose, onSaved }: ComposerProps) {
  const publishWallet = useWalletSync();
  const storedDraft = getDraft(client, record?.id ?? CREATE_DRAFT_KEY);
  const existing = !record ? getPending(client) : null;
  const existingEdit = record ? getPendingEdit(client, record.id) : null;
  const [currentTask, setTask] = useState(existing?.task ?? storedDraft?.task ?? task);
  const [currentDate, setDate] = useState(existing?.body.business_date ?? existing?.body.expected_today ?? storedDraft?.date ?? date);
  const [editing, setEditing] = useState<Checkin | undefined>(existingEdit?.record ?? storedDraft?.record ?? record);
  const [text, setText] = useState(existing?.draftText ?? existingEdit?.draftText ?? storedDraft?.text ?? initialText ?? record?.text ?? '');
  const textRef = useRef(text);
  const [media, setMedia] = useState<MediaDraft>(() => existing?.draftMedia ?? existingEdit?.draftMedia ?? storedDraft?.media ?? (record ? mediaDraftFromRecord(record) : emptyMediaDraft()));
  const mediaRef = useRef(media);
  const [pending, setPending] = useState<PendingCheckin | null>(existing);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(existingEdit);
  const [busy, setBusy] = useState(false);
  const [historyBlocked, setHistoryBlocked] = useState(!management && (storedDraft?.needsManagement === true || record?.can_edit === false));
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [latestContent, setLatestContent] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const textId = useId();
  const errorCode = error instanceof ApiFailure ? error.detail.code : '';
  const tooLong = [...text].length > session.limits.text_max;
  const unresolved = pending !== null || pendingEdit !== null;

  // 草稿始终独立于发送状态，上传或鉴权失败导致卸载时仍可恢复。
  function persistDraft(nextText = textRef.current, nextMedia = mediaRef.current, nextRecord = editing ?? null, needsManagement = historyBlocked) {
    rememberDraft(client, nextRecord?.id ?? CREATE_DRAFT_KEY, { task: currentTask, date: currentDate, management, text: nextText, media: nextMedia, record: nextRecord, needsManagement });
  }

  // 确认保存或放弃后才删除对应草稿。
  function clearDraft() {
    rememberDraft(client, editing?.id ?? CREATE_DRAFT_KEY, null);
    if (!record) rememberDraft(client, CREATE_DRAFT_KEY, null);
  }

  // 输入与原请求分开存储，处理中也不会改变已发出的请求。
  function changeText(value: string) {
    textRef.current = value; setText(value); persistDraft(value);
    if (pending) pending.draftText = value;
    if (pendingEdit) pendingEdit.draftText = value;
  }

  // 每项上传成功立即保留ID，失败只重试未成功部分。
  function updateMedia(value: MediaDraft) {
    mediaRef.current = value; setMedia(value); persistDraft(textRef.current, value);
    if (pending) pending.draftMedia = value;
    if (pendingEdit) pendingEdit.draftMedia = value;
  }

  // 替换时仅撤回已放弃的ready文件，原未知请求所需媒体始终受保护。
  function changeMedia(value: MediaDraft) {
    const previous = mediaRef.current;
    const protectedIDs = [...draftMediaIDs(value), pending?.body.photo_media_id, pending?.body.audio_media_id, pendingEdit?.body.photo_media_id, pendingEdit?.body.audio_media_id].filter((id): id is string => Boolean(id));
    updateMedia(value);
    void discardMediaDraft(client, previous, protectedIDs).catch(() => {});
  }

  // 放弃尚未提交的草稿只取消临时上传，已关联附件由编辑事务管理。
  function abandon() {
    void discardMediaDraft(client, mediaRef.current, []).catch(() => {});
    clearDraft(); onClose();
  }

  // 未确认请求关闭后留在内存中；关闭采集由媒体组件卸载负责。
  function close() {
    if (busy) return;
    if (unresolved || historyBlocked) { onClose(); return; }
    const baseline = editing ?? { photo_media_id: null, audio_media_id: null };
    if (text !== (editing?.text ?? initialText ?? '') || !mediaMatches(mediaRef.current, baseline)) { setDiscard(true); return; }
    abandon();
  }

  // 明确拒绝媒体关联后才允许重新上传，未知结果必须先按原命令核对。
  function handleFailure(failure: unknown, submitted: boolean) {
    if (submitted && failure instanceof ApiFailure && ['INVALID_MEDIA', 'MEDIA_UNAVAILABLE'].includes(failure.detail.code)) {
      updateMedia(renewUnavailableMedia(mediaRef.current));
      setNotice(content.mediaRenewed);
    }
    setError(failure);
  }

  // 编辑重放先确定原版本结果，再让用户确认当前草稿与最新内容的差异。
  async function saveEdit(target: Checkin) {
    let command = pendingEdit;
    try {
      if (!command) {
        const submittedText = textRef.current;
        const uploaded = await uploadMediaDraft(client, mediaRef.current, updateMedia);
        command = { path: `${management ? '/management' : ''}/checkins/${target.id}`, record: target, body: Object.freeze({ expected_version: target.version, text: submittedText, photo_media_id: uploaded.photo?.mediaId ?? null, audio_media_id: uploaded.audio?.mediaId ?? null }), draftText: textRef.current, draftMedia: mediaRef.current };
        rememberEdit(client, target.id, command); setPendingEdit(command);
      }
      const resolved = await replayEdit(client, command);
      rememberEdit(client, target.id, null); setPendingEdit(null); setEditing(resolved.record);
      updateMedia(markAttached(mediaRef.current, resolved.record));
      setHistoryBlocked(!management && !resolved.record.can_edit);
      persistDraft(textRef.current, mediaRef.current, resolved.record, !resolved.record.can_edit);
      if (!resolved.applied) {
        setNotice(resolved.requiresManagement ? content.historyNeedsManagement : content.latestRecordContent); setLatestContent(resolved.record.text);
        setError(new ApiFailure(resolved.requiresManagement ? 403 : 409, { code: resolved.requiresManagement ? 'HISTORY_READ_ONLY' : 'VERSION_CONFLICT', field_errors: {}, request_id: '' }));
        return;
      }
      onSaved(content.saved, resolved.record);
      if (textRef.current !== command.body.text || !mediaMatches(mediaRef.current, command.body)) setNotice(content.editResolved);
      else { rememberDraft(client, target.id, null); clearDraft(); onClose(); }
    } catch (failure) {
      if (isDefiniteFailure(failure)) { rememberEdit(client, target.id, null); setPendingEdit(null); }
      handleFailure(failure, command !== null);
    }
  }

  // 服务端成功与随后界面刷新分开处理，不将读取失败误认为提交失败。
  async function save() {
    if (busy || recording || (!unresolved && (tooLong || historyBlocked))) return;
    persistDraft();
    setBusy(true); setError(null);
    if (editing) {
      try { await saveEdit(editing); }
      finally { setBusy(false); }
      return;
    }
    let command = pending;
    try {
      if (!command) {
        const submittedText = textRef.current;
        const uploaded = await uploadMediaDraft(client, mediaRef.current, updateMedia);
        command = createPendingCheckin(currentTask, currentDate, submittedText, management, uploaded);
        command.draftText = textRef.current;
        rememberPending(client, command); setPending(command);
      }
      const result = await replayCheckin(client, command);
      publishWallet(result.wallet);
      rememberPending(client, null); setPending(null);
      if (result.checkin.deleted) {
        onSaved(content.resolvedDeleted); clearDraft(); onClose();
      } else {
        updateMedia(markAttached(mediaRef.current, result.checkin));
        onSaved(content.success, result.checkin, true);
        if (textRef.current !== command.body.text || !mediaMatches(mediaRef.current, command.body)) {
          setEditing(result.checkin); setHistoryBlocked(!management && !result.checkin.can_edit);
          rememberDraft(client, CREATE_DRAFT_KEY, null);
          persistDraft(textRef.current, mediaRef.current, result.checkin, !result.checkin.can_edit); setNotice(content.resolvedEdit);
        } else { clearDraft(); onClose(); }
      }
    } catch (failure) {
      if (isDefiniteFailure(failure)) { rememberPending(client, null); setPending(null); }
      handleFailure(failure, command !== null);
    } finally { setBusy(false); }
  }

  // 冲突后的重新确认由用户显式触发，既保留草稿也不静默改日。
  async function confirmLatest() {
    setBusy(true); setError(null);
    try {
      if (editing) {
        const latest = await readCurrentRecord(client, editing);
        setEditing(latest); updateMedia(markAttached(mediaRef.current, latest));
        setHistoryBlocked(!management && !latest.can_edit); persistDraft(textRef.current, mediaRef.current, latest, !latest.can_edit);
        return;
      }
      const [tasks, freshSession] = await Promise.all([
        client.request<{ items: Task[] }>(management ? '/tasks?include_inactive=true' : '/tasks'),
        client.request<Session>('/session'),
      ]);
      const found = tasks.items.find((item) => item.id === currentTask.id);
      if (!found || !found.enabled) throw new ApiFailure(409, { code: 'TASK_UNAVAILABLE', field_errors: {}, request_id: '' });
      setTask(found);
      if (!management) setDate(freshSession.today);
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }

  return <Modal title={editing ? content.edit : content.newCheckin} onClose={close} closeDisabled={busy}>
    {discard ? <div className="checkin-stack"><p>{content.discardQuestion}</p><div className="checkin-actions"><button onClick={() => setDiscard(false)}>{content.keepEditing}</button><button className="secondary" onClick={abandon}>{content.discard}</button></div></div> :
      <form className="checkin-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="checkin-composer-header"><TaskIcon name={editing?.task_icon_snapshot ?? currentTask.icon_key} /><h3>{editing?.task_name_snapshot ?? currentTask.name}</h3></div>
        <p>{content.date}：{editing?.business_date ?? currentDate}</p>
        {!editing && <p className="checkin-rewards"><CurrencyAmount currency="coins" amount={currentTask.coin_reward} /><CurrencyAmount currency="diamonds" amount={currentTask.diamond_reward} /></p>}
        {!editing && management && <p className="checkin-hint">{content.backfillWarning}</p>}
        <label htmlFor={textId}>{content.text}</label>
        <textarea id={textId} rows={4} value={text} onChange={(event) => changeText(event.target.value)} aria-invalid={tooLong} />
        {tooLong && <p role="alert" className="checkin-error">{content.textTooLong}</p>}
        <FieldError error={error} field="text" />
        <MediaEditor value={media} onChange={changeMedia} limits={session.limits} disabled={busy} onRecordingChange={setRecording} />
        {notice && <p role="status">{notice}</p>}
        {historyBlocked && !unresolved && <p role="status">{content.historyNeedsManagement}</p>}
        {latestContent !== null && <p className="checkin-text">{latestContent}</p>}
        {unresolved && !busy && <p role="status" className="checkin-warning">{pendingEdit ? content.unknownEditResult : content.unknownResult}</p>}
        {error !== null && <p role="alert" className="checkin-error">{checkinError(error)}</p>}
        {!unresolved && ['DAY_CHANGED', 'TASK_CHANGED', 'VERSION_CONFLICT'].includes(errorCode) && <button type="button" className="secondary" disabled={busy} onClick={() => void confirmLatest()}>{editing ? content.refreshRecord : content.confirmLatest}</button>}
        <button type="submit" disabled={busy || recording || (!unresolved && (tooLong || historyBlocked))}>{busy ? content.saving : unresolved ? content.recover : editing ? content.save : content.checkin}</button>
      </form>}
  </Modal>;
}
