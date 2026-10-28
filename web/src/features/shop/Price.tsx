import content from './content.json';

// 金币与钻石同时呈现，并以文字标明币种，不仅依赖颜色。
export function Price({ coins, diamonds }: { coins: number; diamonds: number }) {
  return (
    <span className="shop-price">
      <span>
        <img src="/api/v1/assets/coin-v1" alt="" />
        {content.coins} <strong>{coins}</strong>
      </span>
      <span>
        <img src="/api/v1/assets/gem-v1" alt="" />
        {content.diamonds} <strong>{diamonds}</strong>
      </span>
    </span>
  );
}
