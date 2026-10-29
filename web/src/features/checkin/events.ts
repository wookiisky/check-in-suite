/** 打卡成功事件只从已确认的新记录发送，读取与内容编辑不触发音效。 */
export const CHECKIN_SUCCESS_EVENT = 'island:checkin-success';

/** 已确认记录的奖励快照，声音与页面使用同一份数量。 */
export interface CheckinSuccessDetail {
  recordId: string; // 本次成功记录的身份。
  coins: number; // 本次实际获得的金币。
  diamonds: number; // 本次实际获得的钻石。
}
