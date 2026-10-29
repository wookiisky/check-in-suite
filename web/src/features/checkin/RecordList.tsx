import { CurrencyAmount } from '../../components/CurrencyAmount';
import type { Checkin } from './types';
import { operationTime } from './format';
import { TaskIcon } from './TaskIcon';
import content from './content.json';

/** 列表以图标呈现内容线索，管理列表才额外显示补录标记与原奖励。 */
export function RecordList({ records, management = false, onSelect }: { records: Checkin[]; management?: boolean; onSelect: (record: Checkin) => void }) {
  if (records.length === 0) return <p className="checkin-empty">{content.noRecords}</p>;
  return <ul className="checkin-record-list">{records.map((record) => <li key={record.id}><button className="checkin-record secondary" onClick={() => onSelect(record)}><TaskIcon name={record.task_icon_snapshot} /><span><strong>{record.task_name_snapshot}</strong><span className="checkin-record-meta">{operationTime(record.created_at)}{management && record.source === 'backfill' ? ` ${content.backfill}` : ''}</span>{(record.text || record.photo_media_id || record.audio_media_id) && <span className="checkin-record-attachments">{record.text && <img className="checkin-attachment-icon" src="/api/v1/assets/message-v1" alt={content.text} />}{record.photo_media_id && <img className="checkin-attachment-icon" src="/api/v1/assets/camera-v1" alt={content.attachmentPhoto} />}{record.audio_media_id && <img className="checkin-attachment-icon" src="/api/v1/assets/mic-v1" alt={content.attachmentAudio} />}</span>}{management && <span className="checkin-record-meta"><CurrencyAmount currency="coins" amount={record.coin_reward_snapshot} /> · <CurrencyAmount currency="diamonds" amount={record.diamond_reward_snapshot} /></span>}</span></button></li>)}</ul>;
}
