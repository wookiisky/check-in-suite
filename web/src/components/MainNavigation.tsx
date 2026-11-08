import content from '../content/zh-CN.json';

const primaryPages = ['camp', 'island', 'stats', 'shop', 'appearance'] as const;
export type PrimaryPage = typeof primaryPages[number];

const icons: Record<PrimaryPage, string> = {
  camp: 'book-v1',
  island: 'home-v1',
  stats: 'chart-v1',
  shop: 'shop-v1',
  appearance: 'icon-appearance-v1',
};

// 普通页面和全屏营地使用同一组入口，各自决定何时可以离开。
export function MainNavigation({ current, disabled, onNavigate }: {
  current: PrimaryPage | null;
  disabled: boolean;
  onNavigate: (page: PrimaryPage) => void;
}) {
  return <nav className="main-navigation" aria-label={content.navigation.label}>
    {primaryPages.map((page) => <button
      type="button"
      key={page}
      className={`nav-button ${current === page ? 'active' : ''}`}
      aria-current={current === page ? 'page' : undefined}
      disabled={disabled}
      onClick={() => { if (page !== current) onNavigate(page); }}
    >
      <img src={`/api/v1/assets/${icons[page]}`} alt="" />
      <span>{content.navigation[page]}</span>
    </button>)}
  </nav>;
}
