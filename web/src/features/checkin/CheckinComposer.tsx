import { useId, useRef, useState } from 'react';
import { ApiFailure } from '../../api/client';
import { Modal } from '../../components/Modal';
import { FieldError } from '../../components/FormFeedback';
import type { Session } from '../../api/types';
import type { Checkin, CheckinClient, Task } from './types';
import { createPendingCheckin, getPending, rememberPending, replayCheckin } from './submission';
import type { PendingCheckin } from './submission';
import { checkinError, isDefiniteFailure } from './format';
import { readCurrentRecord } from './records';
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

/** 保留原命令直到结果明确；修改后的草稿只会编辑原成功记录。 */
export function CheckinComposer({ client, session, task, date, management = false, record, initialText, onClose, onSaved }: ComposerProps) {
  const existing = !record ? getPending(client) : null;
  const [currentTask, setTask] = useState(existing?.task ?? task);
  const [currentDate, setDate] = useState(existing?.body.business_date ?? existing?.body.expected_today ?? date);
  const [editing, setEditing] = useState<Checkin | undefined>(record);
  const [text, setText] = useState(existing?.draftText ?? initialText ?? record?.text ?? '');
  const textRef = useRef(text);
  const [pending, setPending] = useState<PendingCheckin | null>(existing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [discard, setDiscard] = useState(false);
  const textId = useId();
  const errorCode = error instanceof ApiFailure ? error.detail.code : '';
  const tooLong = [...text].length > session.limits.text_max;

  // 输入与原请求分开存储，处理中也不会改变已发出的请求。
  function changeText(value: string) {
    textRef.current = value;
    setText(value);
    if (pending) pending.draftText = value;
  }

  // 未确认提交只隐藏弹窗，未提交的修改则先询问是否放弃。
  function close() {
    if (busy) return;
    if (pending) { pending.draftText = textRef.current; onClose(); return; }
    if (text !== (editing?.text ?? initialText ?? '')) { setDiscard(true); return; }
    onClose();
  }

  // 服务端成功与随后界面刷新分开处理，不将读取失败误认为提交失败。
  async function save() {
    if (busy || (!pending && tooLong)) return;
    setBusy(true);
    setError(null);
    if (editing) {
      try {
        const updated = await client.request<Checkin>(`${management ? '/management' : ''}/checkins/${editing.id}`, { method: 'PATCH', body: { expected_version: editing.version, text: textRef.current, photo_media_id: editing.photo_media_id, audio_media_id: editing.audio_media_id } });
        onSaved(content.saved, updated);
        onClose();
      } catch (failure) { setError(failure); }
      finally { setBusy(false); }
      return;
    }
    const command = pending ?? createPendingCheckin(currentTask, currentDate, textRef.current, management);
    rememberPending(client, command);
    setPending(command);
    try {
      const result = await replayCheckin(client, command);
      rememberPending(client, null);
      setPending(null);
      if (result.checkin.deleted) {
        onSaved(content.resolvedDeleted);
        onClose();
      } else if (textRef.current !== command.body.text) {
        setEditing(result.checkin);
        setNotice(content.resolvedEdit);
        onSaved(content.success, result.checkin, true);
      } else {
        onSaved(content.success, result.checkin, true);
        onClose();
      }
    } catch (failure) {
      if (isDefiniteFailure(failure)) { rememberPending(client, null); setPending(null); }
      setError(failure);
    } finally { setBusy(false); }
  }

  // 冲突后的重新确认由用户显式触发，既保留草稿也不静默改日。
  async function confirmLatest() {
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        setEditing(await readCurrentRecord(client, editing));
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
    {discard ? <div className="checkin-stack"><p>{content.discardQuestion}</p><div className="checkin-actions"><button onClick={() => setDiscard(false)}>{content.keepEditing}</button><button className="secondary" onClick={onClose}>{content.discard}</button></div></div> :
      <form className="checkin-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <h3>{editing?.task_name_snapshot ?? currentTask.name}</h3>
        <p>{content.date}：{editing?.business_date ?? currentDate}</p>
        {!editing && <p className="checkin-rewards"><span>{content.coins} {currentTask.coin_reward}</span><span>{content.diamonds} {currentTask.diamond_reward}</span></p>}
        {!editing && management && <p className="checkin-hint">{content.backfillWarning}</p>}
        <label htmlFor={textId}>{content.text}</label>
        <textarea id={textId} rows={4} value={text} onChange={(event) => changeText(event.target.value)} aria-invalid={tooLong} />
        <p className="checkin-hint">{content.optionalText}（{[...text].length}/{session.limits.text_max}）</p>
        <FieldError error={error} field="text" />
        {notice && <p role="status">{notice}</p>}
        {pending && !busy && <p role="status" className="checkin-warning">{content.unknownResult}</p>}
        {error !== null && <p role="alert" className="checkin-error">{checkinError(error)}</p>}
        {!pending && ['DAY_CHANGED', 'TASK_CHANGED', 'VERSION_CONFLICT'].includes(errorCode) && <button type="button" className="secondary" disabled={busy} onClick={() => void confirmLatest()}>{editing ? content.refreshRecord : content.confirmLatest}</button>}
        <button type="submit" disabled={busy || (!pending && tooLong)}>{busy ? content.saving : pending ? content.recover : editing ? content.save : content.checkin}</button>
      </form>}
  </Modal>;
}
