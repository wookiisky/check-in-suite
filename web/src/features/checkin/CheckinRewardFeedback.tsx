import { CurrencyIcon } from '../../components/CurrencyAmount';
import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { useReducedMotion } from '../shop/useReducedMotion';
import content from './content.json';

/** 每次成功回执的奖励，调用方用记录 ID 作为 key，普通刷新不重新播放。 */
interface CheckinRewardFeedbackProps {
  coins: number; // 回执中的金币奖励。
  diamonds: number; // 回执中的钻石奖励。
  reduceMotion: boolean; // 账户的减少动效偏好。
}

/** 粒子轨迹通过 CSS 变量传递，只动画 transform 和 opacity。 */
interface RewardParticleStyle extends CSSProperties {
  '--reward-x': string; // 相对奖励卡中心的水平距离。
  '--reward-y': string; // 相对奖励卡中心的垂直距离。
  '--reward-turn': string; // 终点的旋转角度。
}

const particleLimit = 50;
const playbackDuration = 1600; // 覆盖最长的钻石动画及错开时间，之后释放装饰节点。

// 两种货币独立按单位出现，数量超过上限仍完整显示实际金额。
export function CheckinRewardFeedback({ coins, diamonds, reduceMotion }: CheckinRewardFeedbackProps) {
  const reducedMotion = useReducedMotion(reduceMotion);
  const [playing, setPlaying] = useState(!reducedMotion);
  useEffect(() => {
    if (reducedMotion) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setPlaying(false), playbackDuration);
    return () => window.clearTimeout(timer);
  }, [reducedMotion]);
  const animate = playing && !reducedMotion;

  return <div className={`checkin-reward-feedback${animate ? ' checkin-reward-playing' : ''}`}>
    {([['coins', coins, 'coin-v1'], ['diamonds', diamonds, 'gem-v1']] as const).map(([currency, amount, asset]) => {
      const count = Math.min(amount, particleLimit);
      const featured = currency === 'diamonds' && amount > 0;
      return <div key={currency} className={`checkin-reward-card checkin-reward-${currency}${featured ? ' checkin-reward-featured' : ''}`}>
        {animate && count > 0 && <div className="checkin-reward-particles" aria-hidden="true">
          {Array.from({ length: count }, (_, index) => {
            // 黄金角分散轨迹，固定错开窗口让大数量更密集，而不是播放更久。
            const angle = index * 2.39996;
            const radius = 36 + (index % 5) * 12;
            const style: RewardParticleStyle = {
              '--reward-x': `${Math.cos(angle) * radius}px`,
              '--reward-y': `${-24 - Math.abs(Math.sin(angle)) * 32}px`,
              '--reward-turn': `${Math.cos(angle) * 35}deg`,
              animationDelay: `${count === 1 ? 0 : index / (count - 1) * 350}ms`,
            };
            return <img key={index} className="checkin-reward-particle" src={`/api/v1/assets/${asset}`} alt="" style={style} />;
          })}
        </div>}
        <div className="checkin-reward-amount">
          <CurrencyIcon currency={currency} className="checkin-reward-icon" />
          <span>{content.rewardAmount.replace('{amount}', String(amount))}</span>
        </div>
      </div>;
    })}
  </div>;
}
