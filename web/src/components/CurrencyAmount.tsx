import type { ReactNode } from 'react';
import content from './content.json';
import './currency.css';

/** 两种币种共用资产映射，名称仅供辅助技术识别。 */
interface CurrencyIconProps {
  currency: 'coins' | 'diamonds'; // 显示的币种。
  label?: string; // 表单等场景所需的完整读屏名称。
  className?: string; // 沿用所在场景的图标样式。
}

/** 金额允许带符号的文字，子节点用于保留已有数值动画。 */
interface CurrencyAmountProps extends CurrencyIconProps {
  amount: number | string; // 已计算的准确金额，不在展示层换算。
  children?: ReactNode; // 可选的数值节点。
}

// 复用现有币种素材，以图片替代可见币种名称。
export function CurrencyIcon({ currency, label, className = '' }: CurrencyIconProps) {
  return <img className={`currency-icon ${className}`.trim()} src={`/api/v1/assets/${currency === 'coins' ? 'coin-v1' : 'gem-v1'}`} alt={label ?? content[currency]} />;
}

// 图标和金额保持在一起，避免换行后失去币种归属。
export function CurrencyAmount({ currency, amount, children, className = '', label }: CurrencyAmountProps) {
  return <span className={`currency-amount ${className}`.trim()}><CurrencyIcon currency={currency} label={label ?? content[currency]} />{children ?? <span>{amount}</span>}</span>;
}
