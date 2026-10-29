import { CurrencyAmount } from '../../components/CurrencyAmount';

// 两种价格共用币种图标，数值保留原始金额。
export function Price({ coins, diamonds }: { coins: number; diamonds: number }) {
  return (
    <span className="shop-price">
      <CurrencyAmount currency="coins" amount={coins}><strong>{coins}</strong></CurrencyAmount>
      <CurrencyAmount currency="diamonds" amount={diamonds}><strong>{diamonds}</strong></CurrencyAmount>
    </span>
  );
}
