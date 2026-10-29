import { CurrencyAmount } from '../../components/CurrencyAmount';
import { achievementRule } from './achievement-format';
import type { Achievement, AchievementInput } from './types';
import content from './content.json';

// 货币条件使用图标表达币种，其他指标沿用原有文字规则。
export function AchievementRule({ item }: { item: AchievementInput }) {
  if (item.metric !== 'coins' && item.metric !== 'diamonds') return achievementRule(item);
  const [before, after] = content.currencyRuleTemplate.replace('{scope}', content.scopes[item.scope]).split('{amount}');
  return <>{before}<CurrencyAmount currency={item.metric} amount={item.target} />{after}</>;
}

// 货币进度保留零值和完整目标，并以同一图标说明两边数值的单位。
export function AchievementProgress({ item }: { item: Achievement }) {
  const amount = content.progressTemplate.replace('{progress}', String(item.progress)).replace('{target}', String(item.target));
  return item.metric === 'coins' || item.metric === 'diamonds' ? <CurrencyAmount currency={item.metric} amount={amount} /> : amount;
}
