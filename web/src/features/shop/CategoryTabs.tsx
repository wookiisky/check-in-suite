import { useId } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { categoryLabel, wardrobeCategories } from './shop-categories';
import type { CategoryFilter } from './shop-categories';
import content from './content.json';

const groups: CategoryFilter['group'][] = ['all', 'appearance', 'island', 'reward'];

// 两级分类共享选择状态，键盘只在当前层级移动并立即显示对应内容。
export function CategoryTabs({ value, onChange, children }: {
  value: CategoryFilter;
  onChange: (value: CategoryFilter) => void;
  children?: ReactNode;
}) {
  const id = useId();
  const panelID = `${id}-panel`;
  const detailsID = `${id}-details`;
  const detailCategories = ['', ...wardrobeCategories] as const;
  // 自动激活模式使焦点、选中项和面板始终一致。
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
    tabs[next]!.focus();
    tabs[next]!.click();
  }
  return <div className="shop-categories">
    <div className="shop-category-tabs shop-category-groups" role="tablist" aria-label={content.categoryGroupLabel} onKeyDown={navigate}>
      {groups.map((group) => <button key={group} id={`${id}-${group}`} type="button" role="tab" className="secondary"
        aria-selected={value.group === group} aria-controls={panelID} tabIndex={value.group === group ? 0 : -1}
        onClick={() => onChange({ group, category: '' })}>{content.categoryGroups[group]}</button>)}
    </div>
    <div id={panelID} className="shop-category-panel" role="tabpanel" aria-labelledby={`${id}-${value.group}`} tabIndex={0}>
      {value.group === 'appearance' ? <>
        <div className="shop-category-tabs shop-category-details" role="tablist" aria-label={content.categoryDetailLabel} onKeyDown={navigate}>
          {detailCategories.map((category) => <button key={category} id={`${id}-category-${category || 'all'}`} type="button" role="tab" className="secondary"
            aria-selected={value.category === category} aria-controls={detailsID} tabIndex={value.category === category ? 0 : -1}
            onClick={() => onChange({ group: 'appearance', category })}>{category ? categoryLabel(category) : content.allTypes}</button>)}
        </div>
        <div id={detailsID} role="tabpanel" aria-labelledby={`${id}-category-${value.category || 'all'}`} tabIndex={0}>{children}</div>
      </> : children}
    </div>
  </div>;
}
