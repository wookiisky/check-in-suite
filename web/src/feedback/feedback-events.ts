/** 仅用于服务器已确认的业务操作，初始加载与普通刷新不发送。 */
export type FeedbackKind = 'purchase' | 'equip' | 'island-save';

/** 共享声音实例接收的业务成功事件。 */
export const FEEDBACK_EVENT = 'island:feedback';

// 业务页面只声明反馈类型，声音开关及播放生命周期由共享实例管理。
export function dispatchFeedback(kind: FeedbackKind): void {
  window.dispatchEvent(new CustomEvent<FeedbackKind>(FEEDBACK_EVENT, { detail: kind }));
}
