// 录音事件只协调当前页面的声音，不用于数据同步。
export const RECORDING_EVENT = 'island:recording';
let active = false;

// 新挂载的声音控件也能取得当前录音状态。
export function isRecordingActive(): boolean { return active; }

// 只在状态改变时通知音乐控件暂停或按用户偏好恢复。
export function setRecordingActive(value: boolean): void {
  if (active === value) return;
  active = value;
  window.dispatchEvent(new CustomEvent<boolean>(RECORDING_EVENT, { detail: value }));
}
