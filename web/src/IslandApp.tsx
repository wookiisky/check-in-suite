import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient, ApiFailure } from './api/client';
import type { Account, Preferences, Session } from './api/types';
import { FormFeedback } from './components/FormFeedback';
import { Modal } from './components/Modal';
import { WalletProvider } from './components/WalletContext';
import { GlobalWallet } from './components/GlobalWallet';
import { LoginForm } from './features/account/LoginForm';
import { ManagementPanel } from './features/account/ManagementPanel';
import type { AccountFormState } from './features/account/ManagementPanel';
import { UnlockDialog } from './features/account/UnlockDialog';
import { CampPage } from './features/checkin/CampPage';
import { CheckinManagement } from './features/checkin/CheckinManagement';
import { ShopPage } from './features/shop/ShopPage';
import { BackpackPage } from './features/shop/BackpackPage';
import { WardrobeDialog } from './features/shop/WardrobeDialog';
import type { Camp as ShopCamp } from './features/shop/types';
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
import islandContent from './features/island/content.json';
import shopContent from './features/shop/content.json';

// 小岛素材与活动代码只在进入页面时加载。
const IslandPage = lazy(() => import('./features/island/IslandPage').then((module) => ({ default: module.IslandPage })));

type Page = 'island' | 'camp' | 'calendar' | 'stats' | 'shop' | 'achievements' | 'backpack';
type ManagementSection = 'account' | 'tasks' | 'records' | 'products' | 'achievements';

const navIcons: Record<Exclude<Page, 'backpack'>, string> = {
  camp: 'book-v1',
  island: 'home-v1',
  calendar: 'calendar-v1',
  stats: 'chart-v1',
  shop: 'shop-v1',
  achievements: 'crown-v1',
};

// 应用仅保存当前会话与页面状态，业务草稿归各功能组件所有。
export function IslandApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState<Page>('camp');
  const [islandReturnPage, setIslandReturnPage] = useState<Exclude<Page, 'island'>>('camp');
  const [soundOpen, setSoundOpen] = useState(false);
  const [wardrobeOpen, setWardrobeOpen] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [management, setManagement] = useState(false);
  const [managementSection, setManagementSection] = useState<ManagementSection>('account');
  const [accountForm, setAccountForm] = useState<AccountFormState>({ dirty: false, pending: false });
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [lockPending, setLockPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const serverOffset = useRef(0);
  const equipmentSync = useRef(0); // 新打开或新保存的装备优先于关闭弹窗后的补读。
  const client = useMemo(() => new ApiClient((status) => {
    setManagement(false); setUnlocking(false); setExpiresAt(null);
    if (status === 401) { setSession(null); setNotice(content.account.sessionExpired); }
    else setNotice(content.account.managementExpired);
  }), []);

  const immersive = session !== null && page === 'island' && !management;
  const accountSaving = management && managementSection === 'account' && accountForm.pending;

  // 强制撤销权限或密码修改成功不受草稿拦截，也不遗留旧的离开操作。
  useEffect(() => {
    if (!management || managementSection !== 'account') {
      setAccountForm({ dirty: false, pending: false });
      setPendingLeave(null);
    }
  }, [management, managementSection]);

  // 全屏页使用独立视口，返回时恢复普通页面滚动。
  useEffect(() => {
    document.body.classList.toggle('island-immersive', immersive);
    return () => document.body.classList.remove('island-immersive');
  }, [immersive]);

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
    equipmentSync.current += 1;
    client.setCsrfToken(value.csrf_token); client.recordServerTime(value.server_now); serverOffset.current = Date.parse(value.server_now) - Date.now();
    setSession(value); setNotice(''); setManagement(false); setLockPending(false); setPage('camp');
  }
  function acceptAccount(account: Account) { setSession((value) => value ? { ...value, account } : null); }
  function acceptPreferences(preferences: Preferences) { setSession((value) => value ? { ...value, account: { ...value.account, preferences } } : null); }
  // 先确认账户草稿，再执行原始操作；保存期间保持表单挂载直到请求结束。
  function leaveAccount(action: () => void) {
    if (accountSaving) return;
    if (management && managementSection === 'account' && accountForm.dirty) setPendingLeave(() => action);
    else action();
  }
  // 只有明确放弃后才离开，继续编辑和关闭弹窗都保留当前输入。
  function discardAccountDraft() {
    const action = pendingLeave;
    setPendingLeave(null);
    action?.();
  }
  async function lock() {
    setManagement(false); setUnlocking(false); setExpiresAt(null); setLockPending(true);
    try { await client.request<void>('/management/lock', { method: 'POST' }); setLockPending(false); }
    catch (reason) { if (reason instanceof ApiFailure && reason.status === 401) setLockPending(false); }
  }
  // 打开新编辑会话后，旧的装备补读不能覆盖本次读取或保存。
  function openWardrobe() {
    equipmentSync.current += 1;
    setNotice('');
    setWardrobeOpen(true);
  }
  function navigate(next: Page) {
    equipmentSync.current += 1;
    if (next === 'island' && page !== 'island') setIslandReturnPage(management ? 'camp' : page);
    setSoundOpen(false); setWardrobeOpen(false); setPage(next);
    if (management) void lock();
  }
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

  return <WalletProvider key={session?.csrf_token ?? 'signed-out'} client={client} active={session !== null}><div className={`application ${immersive ? 'application-island' : ''}`}>
    {!immersive && <div className="global-wallet-bar"><div className="global-wallet-bar-inner">
      <a className="brand" href="#" aria-disabled={accountSaving || undefined} onClick={(event) => { event.preventDefault(); leaveAccount(() => navigate('camp')); }}><svg aria-hidden="true" viewBox="0 0 48 48"><path fill="#628643" d="M24 3 7 28h11L9 39h30l-9-11h11z"/><path fill="#865b19" d="M21 37h6v9h-6z"/></svg><strong>{content.appName}</strong></a>
      {session && <GlobalWallet reduceMotion={session.account.preferences.reduce_motion} />}
    </div></div>}
    {!immersive && session && <header className="site-header"><div className="header-inner">
      {session && <><nav aria-label={content.navigation.label}>{(['camp', 'island', 'calendar', 'stats', 'shop', 'achievements'] as const).map((item) => <button key={item} className={`nav-button ${!management && page === item ? 'active' : ''}`} aria-current={!management && page === item ? 'page' : undefined} disabled={accountSaving} onClick={() => leaveAccount(() => navigate(item))}><img src={`/api/v1/assets/${navIcons[item]}`} alt="" aria-hidden="true" /><span>{content.navigation[item]}</span></button>)}</nav><div className="account-tools"><span className="name-chip"><img src="/api/v1/assets/user-v1" alt="" aria-hidden="true" /><span>{session.account.display_name}</span></span><button className="secondary" disabled={busy || accountSaving} onClick={() => leaveAccount(() => void logout())}>{content.account.logout}</button>{!management && <button className="secondary header-management-entry" disabled={lockPending} onClick={(event) => { event.currentTarget.focus(); setNotice(''); setUnlocking(true); }}><img src="/api/v1/assets/settings-v1" alt="" aria-hidden="true" /><span>{content.navigation.management}</span></button>}</div></>}
    </div></header>}
    <main className={immersive ? 'island-app-shell' : 'app-shell'}>
      {notice && <p className="notice" role="status">{notice}</p>}
      {loading ? <p role="status">{content.common.loading}</p> : error && !session ? <section className="panel"><FormFeedback error={error} /><button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{content.common.retry}</button></section> : !session ? <LoginForm client={client} onLogin={acceptSession} /> : <>
        <FormFeedback error={error} />
        {lockPending && <div className="notice" role="alert"><p>{content.account.lockUnconfirmed}</p><button type="button" onClick={() => void lock()}>{content.account.retryLock}</button></div>}
        <div key={management ? 'management' : page} className={immersive ? 'page-content page-content-island' : management ? 'page-content management-workspace' : 'page-content'}>
        {management ? <>
          <div className="management-toolbar"><button className="secondary" disabled={accountSaving} onClick={() => leaveAccount(() => void lock())}>{content.account.leaveManagement}</button></div>
          <nav className="management-sections" aria-label={content.navigation.management}>
            {(['account', 'tasks', 'records', 'products', 'achievements'] as const).map((section) =>
              <button key={section} className="secondary" disabled={accountSaving} aria-pressed={managementSection === section} onClick={() => { if (section !== managementSection) leaveAccount(() => setManagementSection(section)); }}>{section === 'achievements' ? content.navigation.achievementManagement : content.navigation[section]}</button>
            )}
          </nav>
          {managementSection === 'account' && <ManagementPanel client={client} session={session} onAccount={acceptAccount} onPasswordChanged={passwordChanged} onFormStateChange={setAccountForm} />}
          {managementSection === 'products' && <ProductManagement client={client} session={session} />}
          {managementSection === 'achievements' && <AchievementManagement client={client} session={session} />}
          {(managementSection === 'tasks' || managementSection === 'records') && <CheckinManagement key={managementSection} client={client} session={session} section={managementSection === 'tasks' ? 'configuration' : 'records'} />}
        </> : <>
          {page === 'camp' && <>
            <h1 className="page-heading">{content.navigation.camp}</h1>
            <CampPage client={client} session={session} renderSidebar={(camp, updateEquipment) => <>
              <section className="camp-character-panel">
                <CharacterPanel equipment={camp.equipment} displayName={camp.account.display_name} reduceMotion={session.account.preferences.reduce_motion} />
                <div className="camp-character-actions">
                  <button type="button" className="secondary" onClick={() => navigate('backpack')}><img src="/api/v1/assets/accessory-backpack-v1" alt="" /><span>{shopContent.backpack}</span></button>
                  <button type="button" className="secondary" onClick={(event) => { event.currentTarget.focus(); openWardrobe(); }}><img src="/api/v1/assets/accessory-brush-v1" alt="" /><span>{shopContent.wardrobeTitle}</span></button>
                </div>
              </section>
              {wardrobeOpen && <WardrobeDialog client={client} session={session} onEquipmentSaved={(equipment) => { equipmentSync.current += 1; updateEquipment(equipment); }} onClose={(refreshEquipment) => {
                setWardrobeOpen(false);
                if (refreshEquipment) {
                  const current = ++equipmentSync.current;
                  void client.request<ShopCamp>('/camp').then((next) => {
                    if (equipmentSync.current === current) updateEquipment(next.equipment);
                  }).catch(() => { if (equipmentSync.current === current) setNotice(shopContent.equipmentRefreshFailed); });
                }
              }} />}
              <AchievementStrip items={camp.achievements} onViewAll={() => navigate('achievements')} />
              <FamilyPanel client={client} session={session} />
            </>} />
          </>}
          {page === 'island' && <Suspense fallback={<section className="island-loading"><button className="secondary" onClick={() => navigate(islandReturnPage)}>{islandContent.back}</button><p role="status">{content.common.loading}</p></section>}><IslandPage client={client} session={session} onCamp={() => navigate('camp')} onShop={() => navigate('shop')} onBack={() => navigate(islandReturnPage)} onSettings={() => setSoundOpen(true)} /></Suspense>}
          {page === 'shop' && <ShopPage client={client} session={session} onBackpack={() => navigate('backpack')} />}
          {page === 'backpack' && <BackpackPage client={client} session={session} onBack={() => navigate('camp')} onIsland={() => navigate('island')} onWardrobe={openWardrobe} />}
          {page === 'backpack' && wardrobeOpen && <WardrobeDialog client={client} session={session} onClose={() => setWardrobeOpen(false)} />}
          {page === 'achievements' && <AchievementPage client={client} session={session} />}
          {page === 'calendar' && <CalendarPage client={client} session={session} />}
          {page === 'stats' && <StatsPage client={client} session={session} />}
        </>}
        </div>
        {/* 设置隐藏时保留声音实例，普通页面只在进入配置后显示控件。 */}
        <SoundPreferences client={client} session={session} onPreferencesChange={acceptPreferences} presentation={management ? 'panel' : 'dialog'} open={immersive && soundOpen} onClose={() => setSoundOpen(false)} />
        {unlocking && <UnlockDialog client={client} onClose={() => setUnlocking(false)} onUnlock={(expiry) => { setUnlocking(false); setManagement(true); setManagementSection('account'); setExpiresAt(expiry); setNotice(''); }} />}
        {management && pendingLeave && <Modal title={content.account.discardTitle} onClose={() => setPendingLeave(null)}><div className="form-stack"><p>{content.account.discardHint}</p><div className="button-row"><button type="button" onClick={discardAccountDraft}>{content.account.discard}</button><button type="button" className="secondary" onClick={() => setPendingLeave(null)}>{content.account.keepEditing}</button></div></div></Modal>}
      </>}
    </main>
  </div></WalletProvider>;
}
