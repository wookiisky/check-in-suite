import { useId } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import './view-tabs.css';

/** 单层标签和共用面板的受控属性。 */
interface ViewTabsProps<T extends string> {
  label: string; // 标签组的可访问名称。
  items: readonly { id: T; label: string }[]; // 顺序就是键盘导航顺序。
  value: T; // 当前标签的稳定标识。
  onChange: (value: T) => void; // 激活另一个标签。
  children: ReactNode; // 当前标签显示的内容。
  className?: string; // 可替换默认的标签栏布局。
  actions?: ReactNode; // 标签栏旁的普通操作，不参与标签键盘导航。
  panelClassName?: string; // 当前页面为共用面板补充的布局。
}

// 标签组保留一个 Tab 键停靠点，方向键、Home 和 End 同步移动焦点并切换。
export function ViewTabs<T extends string>({ label, items, value, onChange, children, className = 'view-tabs', actions, panelClassName }: ViewTabsProps<T>) {
  const id = useId();
  const panelID = `${id}-panel`;

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const current = tabs.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    let next: number;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  }

  const tabList = <div className={className} role="tablist" aria-label={label} onKeyDown={navigate}>
    {items.map((item) => <button
      key={item.id}
      id={`${id}-tab-${item.id}`}
      type="button"
      role="tab"
      className="secondary"
      aria-selected={item.id === value}
      aria-controls={panelID}
      tabIndex={item.id === value ? 0 : -1}
      onClick={() => onChange(item.id)}
    >{item.label}</button>)}
  </div>;
  return <>
    {actions ? <div className="view-tabs-header">{tabList}{actions}</div> : tabList}
    <div id={panelID} className={panelClassName ? `view-tab-panel ${panelClassName}` : 'view-tab-panel'} role="tabpanel" aria-labelledby={`${id}-tab-${value}`} tabIndex={0}>{children}</div>
  </>;
}
