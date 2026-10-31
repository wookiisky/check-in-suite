import { useEffect, useRef, useState } from 'react';
import { CurrencyAmount } from './CurrencyAmount';
import { useWallet } from './WalletContext';
import { CHECKIN_SUCCESS_EVENT } from '../features/checkin/events';
import type { CheckinSuccessDetail } from '../features/checkin/events';
import { useReducedMotion } from '../features/shop/useReducedMotion';
import content from './content.json';

// 钱包在普通页面间保持挂载，新的打卡反馈只消费一次。
export function GlobalWallet({ reduceMotion = false }: { reduceMotion?: boolean }) {
  const { wallet, error, loading, reload } = useWallet();
  const staticMotion = useReducedMotion(reduceMotion);
  const [feedbackID, setFeedbackID] = useState('');
  const consumed = useRef(new Set<string>());
  useEffect(() => {
    if (staticMotion) setFeedbackID('');
    const confirmed = (event: Event) => {
      const { recordId, coins, diamonds } = (event as CustomEvent<CheckinSuccessDetail>).detail;
      if (consumed.current.has(recordId)) return;
      consumed.current.add(recordId);
      if (!staticMotion && (coins !== 0 || diamonds !== 0)) setFeedbackID(recordId);
    };
    window.addEventListener(CHECKIN_SUCCESS_EVENT, confirmed);
    return () => window.removeEventListener(CHECKIN_SUCCESS_EVENT, confirmed);
  }, [staticMotion]);
  return <section className="global-wallet" aria-label={content.walletBalance} aria-busy={!wallet && loading}>
    <div className="global-wallet-amounts">
      {(['coins', 'diamonds'] as const).map((currency) => <CurrencyAmount key={currency} currency={currency} amount={wallet?.[currency] ?? content.unknownAmount}>
        <strong key={`${currency}-${feedbackID}`} className={feedbackID && !staticMotion ? 'feedback-pop' : undefined} onAnimationEnd={() => setFeedbackID('')}>{wallet?.[currency] ?? content.unknownAmount}</strong>
      </CurrencyAmount>)}
    </div>
    {!wallet && loading && <span className="sr-only" role="status">{content.walletLoading}</span>}
    {!wallet && error !== null && <div className="global-wallet-error"><p role="status">{content.walletError}</p><button type="button" className="secondary" onClick={reload}>{content.walletRetry}</button></div>}
  </section>;
}
