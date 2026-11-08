import { AppearanceEditor } from './AppearanceEditor';
import type { AppearanceEditorProps } from './AppearanceEditor';

// 素材验证入口在独立样例中嵌入编辑器。
export function AppearanceDialog(props: AppearanceEditorProps & { onClose: () => void }) {
  return <AppearanceEditor {...props} />;
}
