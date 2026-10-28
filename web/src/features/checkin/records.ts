import { ApiFailure } from '../../api/client';
import type { Checkin, CheckinClient, CheckinPage } from './types';

/** 按原所属日期逐页读取目标记录，供冲突后的显式重新确认复用。 */
export async function readCurrentRecord(client: CheckinClient, record: Checkin): Promise<Checkin> {
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ start_date: record.business_date, end_date: record.business_date });
    if (cursor) query.set('cursor', cursor);
    const page: CheckinPage = await client.request(`/checkins?${query}`);
    const found = page.items.find((item) => item.id === record.id);
    if (found) return found;
    cursor = page.next_cursor;
  } while (cursor);
  throw new ApiFailure(404, { code: 'NOT_FOUND', field_errors: {}, request_id: '' });
}
