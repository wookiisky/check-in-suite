import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient, ApiFailure } from './api/client';
import type { Account, Preferences, Session } from './api/types';
import { FormFeedback } from './components/FormFeedback';
import { LoginForm } from './features/account/LoginForm';
import { ManagementPanel } from './features/account/ManagementPanel';
import { UnlockDialog } from './features/account/UnlockDialog';
import { CampPage } from './features/checkin/CampPage';
import { CheckinManagement } from './features/checkin/CheckinManagement';
import { ShopPage } from './features/shop/ShopPage';
import { ProductManagement } from './features/shop/ProductManagement';
import { CalendarPage } from './features/reports/CalendarPage';
import { StatsPage } from './features/reports/StatsPage';
import { CharacterPanel } from './features/shop/CharacterPanel';
import { FamilyPanel } from './features/family/FamilyPanel';
import { AchievementPage } from './features/achievements/AchievementPage';
import { AchievementManagement } from './features/achievements/AchievementManagement';
import { AchievementStrip } from './features/achievements/AchievementStrip';
import { SoundPreferences } from './features/family/SoundPreferences';
import content from './content/zh-CN.json';

type Page = 'camp' | 'calendar' | 'stats' | 'shop' | 'achievements';
type ManagementSection = 'account' | 'tasks' | 'records' | 'products' | 'achievements';

// 应用仅保存当前会话与页面状态，业务草稿归各功能组件所有。
export function IslandApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState<Page>('camp');
  const [unlocking, setUnlocking] = useState(false);
  const [management, setManagement] = useState(false);
  const [managementSection, setManagementSection] = useState<ManagementSection>('account');
  const [lockPending, setLockPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const serverOffset = useRef(0);
  const client = useMemo(() => new ApiClient((status) => {
    setManagement(false); setUnlocking(false); setExpiresAt(null);
    if (status === 401) { setSession(null); setNotice(content.account.sessionExpired); }
    else setNotice(content.account.managementExpired);
  }), []);

  // 页面进入时读取会话；取消请求后不接受迟到响应。
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    client.request<Session>('/session', { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      client.setCsrfToken(value.csrf_token); client.recordServerTime(value.server_now); serverOffset.current = Date.parse(value.server_now) - Date.now();
      setSession(value); setNotice('');
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiFailure && reason.status === 401) setNotice('');
      else setError(reason);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, loadAttempt]);

  // 到期只关闭当前管理页面，服务器仍是权限判断依据。
  useEffect(() => {
    if (!management || !expiresAt) return;
    const timer = window.setTimeout(() => {
      setManagement(false); setExpiresAt(null); setNotice(content.account.managementExpired);
    }, Math.max(0, Date.parse(expiresAt) - Date.now() - serverOffset.current));
    return () => window.clearTimeout(timer);
  }, [management, expiresAt]);

  function acceptSession(value: Session) {
    client.setCsrfToken(value.csrf_token); client.recordServerTime(value.server_now); serverOffset.current = Date.parse(value.server_now) - Date.now();
    setSession(value); setNotice(''); setManagement(false); setLockPending(false); setPage('camp');
  }
  function acceptAccount(account: Account) { setSession((value) => value ? { ...value, account } : null); }
  function acceptPreferences(preferences: Preferences) { setSession((value) => value ? { ...value, account: { ...value.account, preferences } } : null); }
  async function lock() {
    setManagement(false); setUnlocking(false); setExpiresAt(null); setLockPending(true);
    try { await client.request<void>('/management/lock', { method: 'POST' }); setLockPending(false); }
    catch (reason) { if (reason instanceof ApiFailure && reason.status === 401) setLockPending(false); }
  }
  function navigate(next: Page) { setPage(next); if (management) void lock(); }
  async function logout() {
    setBusy(true); setError(null); setManagement(false); setUnlocking(false);
    try {
      await client.request<void>('/auth/logout', { method: 'POST' });
      setSession(null); client.setCsrfToken(''); setNotice(''); setLockPending(false);
    } catch (reason) { setError(reason); setNotice(content.account.logoutUnconfirmed); }
    finally { setBusy(false); }
  }
  function passwordChanged() {
    setSession(null); setManagement(false); setExpiresAt(null); client.setCsrfToken(''); setNotice(content.account.passwordChanged);
  }

  return <div className="application">
    <header className="site-header"><div className="header-inner">
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); navigate('camp'); }}><svg aria-hidden="true" viewBox="0 0 48 48"><path fill="#628643" d="M24 3 7 28h11L9 39h30l-9-11h11z"/><path fill="#865b19" d="M21 37h6v9h-6z"/></svg><strong>{content.appName}</strong></a>
      {session && <><nav aria-label={content.navigation.label}>{(['camp', 'calendar', 'stats', 'shop', 'achievements'] as const).map((item) => <button key={item} className={`nav-button ${!management && page === item ? 'active' : ''}`} aria-current={!management && page === item ? 'page' : undefined} onClick={() => navigate(item)}>{content.navigation[item]}</button>)}</nav><div className="account-tools"><span className="name-chip">{session.account.display_name}</span><button className="secondary" disabled={busy} onClick={() => void logout()}>{content.account.logout}</button></div></>}
    </div></header>
    <main className="app-shell">
      {notice && <p className="notice" role="status">{notice}</p>}
      {loading ? <p role="status">{content.common.loading}</p> : error && !session ? <section className="panel"><FormFeedback error={error} /><button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{content.common.retry}</button></section> : !session ? <LoginForm client={client} onLogin={acceptSession} /> : <>
        <FormFeedback error={error} />
        {lockPending && <div className="notice" role="alert"><p>{content.account.lockUnconfirmed}</p><button type="button" onClick={() => void lock()}>{content.account.retryLock}</button></div>}
        {management ? <>
          <div className="management-toolbar"><button className="secondary" onClick={() => void lock()}>{content.account.leaveManagement}</button></div>
          <nav className="management-sections" aria-label={content.navigation.management}>
            {(['account', 'tasks', 'records', 'products', 'achievements'] as const).map((section) =>
              <button key={section} className="secondary" aria-pressed={managementSection === section} onClick={() => setManagementSection(section)}>{section === 'achievements' ? content.navigation.achievementManagement : content.navigation[section]}</button>
            )}
          </nav>
          {managementSection === 'account' && <ManagementPanel client={client} session={session} onAccount={acceptAccount} onPasswordChanged={passwordChanged} />}
          {managementSection === 'products' && <ProductManagement client={client} session={session} />}
          {managementSection === 'achievements' && <AchievementManagement client={client} session={session} />}
          {(managementSection === 'tasks' || managementSection === 'records') && <CheckinManagement key={managementSection} client={client} session={session} section={managementSection === 'tasks' ? 'configuration' : 'records'} />}
        </> : <>
          {page === 'camp' && <>
            <h1 className="page-heading">{content.navigation.camp}</h1>
            <CampPage client={client} session={session} renderSidebar={(camp) => <>
              <CharacterPanel equipment={camp.equipment} displayName={camp.account.display_name} reduceMotion={session.account.preferences.reduce_motion} />
              <AchievementStrip items={camp.achievements} onViewAll={() => navigate('achievements')} />
              <FamilyPanel client={client} session={session} />
            </>} />
          </>}
          {page === 'shop' && <ShopPage client={client} session={session} />}
          {page === 'achievements' && <AchievementPage client={client} session={session} />}
          {page === 'calendar' && <CalendarPage client={client} session={session} />}
          {page === 'stats' && <StatsPage client={client} session={session} />}
          <div className="management-entry"><button className="secondary" disabled={lockPending} onClick={(event) => { event.currentTarget.focus(); setNotice(''); setUnlocking(true); }}>{content.navigation.management}</button></div>
        </>}
        <SoundPreferences client={client} session={session} onPreferencesChange={acceptPreferences} />
        {unlocking && <UnlockDialog client={client} onClose={() => setUnlocking(false)} onUnlock={(expiry) => { setUnlocking(false); setManagement(true); setManagementSection('account'); setExpiresAt(expiry); setNotice(''); }} />}
      </>}
    </main>
  </div>;
}
