import type { Ref } from 'react';
import { AppearanceEditor } from './AppearanceEditor';
import type { AppearanceEditorProps, AppearanceLeaveGuard } from './AppearanceEditor';
import './shop.css';

export type { AppearanceLeaveGuard } from './AppearanceEditor';

// 页面与素材验证入口共享编辑状态；主导航离开前由编辑器处理草稿。
export function AppearancePage(props: AppearanceEditorProps & { leaveGuardRef: Ref<AppearanceLeaveGuard> }) {
  return <AppearanceEditor {...props} />;
}
