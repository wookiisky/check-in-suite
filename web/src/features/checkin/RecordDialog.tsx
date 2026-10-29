import { CurrencyAmount } from '../../components/CurrencyAmount';
import { useState } from 'react';
import { ApiFailure } from '../../api/client';
import { readCurrentRecord } from './records';
import { getPendingEdit } from './media-submission';
import { getDraft } from './drafts';
import { Modal } from '../../components/Modal';
import type { Session } from '../../api/types';
import type { Checkin, CheckinClient, Task } from './types';
import { CheckinComposer } from './CheckinComposer';
import { TaskIcon } from './TaskIcon';
import { checkinError, operationTime } from './format';
import content from './content.json';

/** 管理入口可纠正历史记录，普通入口只能编辑服务端今天的记录。 */
interface RecordDialogProps {
  client: CheckinClient; // 已认证请求客户端。
  session: Session; // 当前文字限制。
  record: Checkin; // 选中的记录快照。
  today: string; // 服务端今天。
  management?: boolean; // 管理页明确使用管理路由。
  onClose: () => void; // 返回记录列表。
  onSaved: (message: string, record?: Checkin, created?: boolean) => void; // 写成功后重新读取。
  onCorrect?: (record: Checkin) => void; // 删除成功后带入补录草稿。
}

/** 详情与普通编辑不展示奖励，只有删除确认显示回收金额。 */
export function RecordDialog({ client, session, record: initialRecord, today, management = false, onClose, onSaved, onCorrect }: RecordDialogProps) {
  const [record, setRecord] = useState(initialRecord);
  const pendingEdit = getPendingEdit(client, record.id);
  const draft = getDraft(client, record.id);
  const [mode, setMode] = useState<'detail' | 'edit' | 'delete' | 'correct'>('detail');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const editable = management || (record.business_date === today && record.can_edit);
  const deletable = management || (record.business_date === today && record.can_delete);
  const task: Task = { id: record.task_id, category_id: null, name: record.task_name_snapshot, icon_key: record.task_icon_snapshot, coin_reward: record.coin_reward_snapshot, diamond_reward: record.diamond_reward_snapshot, daily_limit: 1, weekdays: [], enabled: false, unlock_activities: [], version: 1 };

  // 删除具有重复成功语义，失败保留原版本以安全重试。
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await client.request(`${management ? '/management' : ''}/checkins/${record.id}`, { method: 'DELETE', body: { expected_version: record.version } });
      onSaved(mode === 'correct' ? content.correctionDeleted : content.deleted);
      onClose();
      if (mode === 'correct') onCorrect?.(record);
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }

  // 冲突后先展示最新内容，再由用户重新打开删除确认，不自动重试写入。
  async function refreshRecord() {
    setBusy(true); setError(null);
    try {
      setRecord(await readCurrentRecord(client, record));
      setMode('detail');
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }

  if (mode === 'edit') return <CheckinComposer client={client} session={session} record={record} task={task} date={record.business_date} management={management} onClose={onClose} onSaved={onSaved} />;
  return <Modal title={content.recordDetail} onClose={onClose} closeDisabled={busy}>
    <div className="checkin-stack">
      <div className="checkin-composer-header"><TaskIcon name={record.task_icon_snapshot} /><h3>{record.task_name_snapshot}</h3></div>
      <p>{content.date}：{record.business_date}{management && record.source === 'backfill' ? ` ${content.backfill}` : ''}</p>
      {management && <p className="checkin-hint">{content.operationTime}：{operationTime(record.created_at)}</p>}
      {mode === 'detail' ? <>
        {record.text && <p className="checkin-text">{record.text}</p>}
        {record.photo_media_id && <img className="checkin-photo" src={`/api/v1/media/${record.photo_media_id}`} alt={content.attachmentPhoto} />}
        {record.audio_media_id && <audio aria-label={content.attachmentAudio} controls src={`/api/v1/media/${record.audio_media_id}`} />}
        {management && <p className="checkin-rewards"><CurrencyAmount currency="coins" amount={record.coin_reward_snapshot} /><CurrencyAmount currency="diamonds" amount={record.diamond_reward_snapshot} /></p>}
        {editable ? <div className="checkin-actions"><button onClick={() => setMode('edit')}>{content.edit}</button>{deletable && <button className="secondary" onClick={() => setMode('delete')}>{content.delete}</button>}{management && onCorrect && <button className="secondary" onClick={() => setMode('correct')}>{content.correctRecord}</button>}</div> : <>{(pendingEdit || draft) && <button onClick={() => setMode('edit')}>{pendingEdit ? content.recover : content.continueDraft}</button>}</>}
      </> : <>
        <p>{mode === 'correct' ? content.correctWarning : content.deleteWarning}</p>
        <p className="checkin-rewards"><CurrencyAmount currency="coins" amount={`−${record.coin_reward_snapshot}`} /><CurrencyAmount currency="diamonds" amount={`−${record.diamond_reward_snapshot}`} /></p>
        {error !== null && <p role="alert" className="checkin-error">{checkinError(error)}</p>}
        {error instanceof ApiFailure && error.detail.code === 'VERSION_CONFLICT' && <button className="secondary" disabled={busy} onClick={() => void refreshRecord()}>{content.refreshRecord}</button>}
        <div className="checkin-actions"><button className="danger" disabled={busy} onClick={() => void remove()}>{busy ? content.saving : mode === 'correct' ? content.confirmCorrection : content.confirmDelete}</button><button className="secondary" disabled={busy} onClick={() => setMode('detail')}>{content.cancel}</button></div>
      </>}
    </div>
  </Modal>;
}
