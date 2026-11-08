import { CurrencyAmount } from '../../components/CurrencyAmount';
import type { Checkin } from './types';
import { operationTime } from './format';
import { TaskIcon } from './TaskIcon';
import content from './content.json';

/** 普通列表使用附件图标，周视图同时展示文字，管理列表保留奖励和补录标记。 */
export function RecordList({ records, management = false, showText = false, onSelect }: { records: Checkin[]; management?: boolean; showText?: boolean; onSelect: (record: Checkin) => void }) {
  if (records.length === 0) return <p className="checkin-empty">{content.noRecords}</p>;
  return <ul className="checkin-record-list">{records.map((record) => {
    const showTextIcon = Boolean(record.text && !showText);
    return <li key={record.id}>
      <button type="button" className="checkin-record secondary" onClick={() => onSelect(record)}>
        {!showText && <TaskIcon name={record.task_icon_snapshot} />}
        <span>
          <strong>{record.task_name_snapshot}</strong>
          {showText && record.text && <span className="checkin-record-text">{record.text}</span>}
          {!showText && <span className="checkin-record-meta">{operationTime(record.created_at)}{management && record.source === 'backfill' ? ` ${content.backfill}` : ''}</span>}
          {(showTextIcon || record.photo_media_id || record.audio_media_id) && <span className="checkin-record-attachments">
            {showTextIcon && <img className="checkin-attachment-icon" src="/api/v1/assets/message-v1" alt={content.text} />}
            {record.photo_media_id && <img className="checkin-attachment-icon" src="/api/v1/assets/camera-v1" alt={content.attachmentPhoto} />}
            {record.audio_media_id && <img className="checkin-attachment-icon" src="/api/v1/assets/mic-v1" alt={content.attachmentAudio} />}
          </span>}
          {management && <span className="checkin-record-meta"><CurrencyAmount currency="coins" amount={record.coin_reward_snapshot} /> · <CurrencyAmount currency="diamonds" amount={record.diamond_reward_snapshot} /></span>}
        </span>
      </button>
    </li>;
  })}</ul>;
}
