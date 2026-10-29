import { CurrencyAmount } from '../../components/CurrencyAmount';
import type { Checkin } from './types';
import { operationTime } from './format';
import { TaskIcon } from './TaskIcon';
import content from './content.json';

/** 列表只显示内容线索，管理列表才额外显示原奖励。 */
export function RecordList({ records, management = false, onSelect }: { records: Checkin[]; management?: boolean; onSelect: (record: Checkin) => void }) {
  if (records.length === 0) return <p className="checkin-empty">{content.noRecords}</p>;
  return <ul className="checkin-record-list">{records.map((record) => <li key={record.id}><button className="checkin-record secondary" onClick={() => onSelect(record)}><TaskIcon name={record.task_icon_snapshot} /><span><strong>{record.task_name_snapshot}</strong><span className="checkin-record-meta">{operationTime(record.created_at)} {record.source === 'backfill' ? content.backfill : ''}</span>{record.text && <span className="checkin-record-meta">{content.text}</span>}{record.photo_media_id && <span className="checkin-record-meta">{content.attachmentPhoto}</span>}{record.audio_media_id && <span className="checkin-record-meta">{content.attachmentAudio}</span>}{management && <span className="checkin-record-meta"><CurrencyAmount currency="coins" amount={record.coin_reward_snapshot} /> · <CurrencyAmount currency="diamonds" amount={record.diamond_reward_snapshot} /></span>}</span></button></li>)}</ul>;
}
