import type { Ref } from 'react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient, ApiFailure } from './api/client';
import type { Account, Preferences, Session } from './api/types';
import { FormFeedback } from './components/FormFeedback';
import { Modal } from './components/Modal';
import { WalletProvider } from './components/WalletContext';
import { GlobalWallet } from './components/GlobalWallet';
import { MainNavigation } from './components/MainNavigation';
import type { PrimaryPage } from './components/MainNavigation';
import { LoginForm } from './features/account/LoginForm';
import { ManagementPanel } from './features/account/ManagementPanel';
import type { AccountFormState } from './features/account/ManagementPanel';
import { UnlockDialog } from './features/account/UnlockDialog';
import { CampPage } from './features/checkin/CampPage';
import { GroupBrowse } from './features/groups/GroupBrowse';
import { MemberCheckins } from './features/groups/MemberCheckins';
import { CheckinManagement } from './features/checkin/CheckinManagement';
import { ShopPage } from './features/shop/ShopPage';
import { AppearancePage } from './features/shop/AppearancePage';
import type { AppearanceLeaveGuard } from './features/shop/AppearancePage';
import { AppearanceProvider, useAppearance } from './features/character/AppearanceProvider';
import { ProductManagement } from './features/shop/ProductManagement';
import { ReportsPage } from './features/reports/ReportsPage';
import { CharacterPanel } from './features/character/CharacterPanel';
import { FamilyPanel } from './features/family/FamilyPanel';
import { AchievementPage } from './features/achievements/AchievementPage';
import { AchievementManagement } from './features/achievements/AchievementManagement';
import { AchievementStrip } from './features/achievements/AchievementStrip';
import { SoundPreferences } from './features/family/SoundPreferences';
import content from './content/zh-CN.json';
import islandContent from './features/island/three/spatial-content.json';

// 小岛素材与活动代码只在进入页面时加载。
const IslandPage = lazy(() => import('./features/island/IslandPage3D').then((module) => ({ default: module.IslandPage3D })));

type Page = PrimaryPage | 'achievements';
type ManagementSection = 'account' | 'tasks' | 'records' | 'products' | 'achievements';

// 装扮保存直接发布已确认的外观，打卡和营地复用同一快照。
function AppearanceWorkspace({ client, session, leaveGuardRef }: {
  client: ApiClient;
  session: Session;
  leaveGuardRef: Ref<AppearanceLeaveGuard>;
}) {
  const { publishSaved } = useAppearance();
  return <AppearancePage client={client} accountID={session.account.id} reduceMotion={session.account.preferences.reduce_motion} leaveGuardRef={leaveGuardRef} onSaved={publishSaved} />;
}

// 应用仅保存当前会话与页面状态，业务草稿归各功能组件所有。
export function IslandApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState<Page>('camp');
  const [shopInitialGroup, setShopInitialGroup] = useState<'scene' | undefined>();
  const [islandReturnPage, setIslandReturnPage] = useState<Exclude<Page, 'island'>>('camp');
  const [soundOpen, setSoundOpen] = useState(false);
  const appearanceLeave = useRef<AppearanceLeaveGuard>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [management, setManagement] = useState(false);
  const [managementSection, setManagementSection] = useState<ManagementSection>('account');
  const [accountForm, setAccountForm] = useState<AccountFormState>({ dirty: false, pending: false });
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [lockPending, setLockPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const serverOffset = useRef(0);
  const accountClients = useRef(new Map<number, ApiClient>()); // 每个账户的内存草稿和未知命令使用独立客户端。
  const authorizationFailure = useCallback((status: number) => {
    setManagement(false); setUnlocking(false); setExpiresAt(null);
    if (status === 401) { setSession(null); setNotice(content.account.sessionExpired); }
    else setNotice(content.account.managementExpired);
  }, []);
  const authenticationClient = useMemo(() => new ApiClient(authorizationFailure), [authorizationFailure]);
  const client = useMemo(() => {
    if (!session) return authenticationClient;
    let scoped = accountClients.current.get(session.account.id);
    if (!scoped) {
      scoped = new ApiClient(authorizationFailure);
      accountClients.current.set(session.account.id, scoped);
    }
    scoped.setCsrfToken(session.csrf_token); scoped.recordServerTime(session.server_now);
    return scoped;
  }, [authenticationClient, authorizationFailure, session?.account.id, session?.csrf_token]);
  // 离开账户后旧请求不能撤销新账户授权；同账户重登仍能恢复原客户端中的未知命令。
  useEffect(() => () => client.setCsrfToken(''), [client]);

  const immersive = session !== null && page === 'island' && !management;
  const MainContainer=immersive?'div':'main'; // 全屏营地自带main地标，普通页面保留外层main。
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
    authenticationClient.request<Session>('/session', { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      authenticationClient.setCsrfToken(value.csrf_token); authenticationClient.recordServerTime(value.server_now); serverOffset.current = Date.parse(value.server_now) - Date.now();
      setSession(value); setNotice('');
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiFailure && reason.status === 401) setNotice('');
      else setError(reason);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [authenticationClient, loadAttempt]);

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
  // 标题栏、品牌和账户操作共用当前页面的草稿确认。
  function leaveWorkspace(action: () => void) {
    if (!management && page === 'appearance' && appearanceLeave.current) appearanceLeave.current(action);
    else leaveAccount(action);
  }

  function navigate(next: Page) {
    if (next === 'island' && page !== 'island') setIslandReturnPage(management ? 'camp' : page);
    if (next === 'shop') setShopInitialGroup(undefined);
    setSoundOpen(false); setPage(next);
    if (management) void lock();
  }

  // 场景购买入口直接打开商店的场景分类。
  function openSceneShop(group?: 'scene') {
    navigate('shop');
    setShopInitialGroup(group);
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

  return <AppearanceProvider key={session?.csrf_token ?? 'signed-out'} client={client} active={session!==null}><WalletProvider key={session?.csrf_token ?? 'signed-out'} client={client} active={session !== null}><div className={`application ${immersive ? 'application-island' : ''}`}>
    {!immersive && <header className="site-header global-wallet-bar"><div className="global-wallet-bar-inner">
      <a className="brand" href="#" aria-disabled={accountSaving || undefined} onClick={(event) => { event.preventDefault(); if (page !== 'camp' || management) leaveWorkspace(() => navigate('camp')); }}><svg aria-hidden="true" viewBox="0 0 48 48"><path fill="#628643" d="M24 3 7 28h11L9 39h30l-9-11h11z"/><path fill="#865b19" d="M21 37h6v9h-6z"/></svg><strong>{content.appName}</strong></a>
      {session && <>
        <MainNavigation current={management || page === 'achievements' ? null : page} disabled={accountSaving} onNavigate={(next) => leaveWorkspace(() => navigate(next))} />
        <GlobalWallet reduceMotion={session.account.preferences.reduce_motion} />
        <div className="account-tools">
          {!management && <button type="button" className="secondary" aria-label={content.navigation.management} title={content.navigation.management} disabled={lockPending} onClick={(event) => {
            event.currentTarget.focus();
            leaveWorkspace(() => { setNotice(''); setUnlocking(true); });
          }}><img src="/api/v1/assets/settings-v1" alt="" /></button>}
          <button type="button" className="secondary" aria-label={content.account.logout} title={content.account.logout} disabled={busy || accountSaving} onClick={() => leaveWorkspace(() => void logout())}>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9" /></svg>
          </button>
        </div>
      </>}
    </div></header>}
    <MainContainer className={immersive ? 'island-app-shell' : 'app-shell'}>
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
            <h1 className="page-heading">{content.navigation.campTitle}</h1>
            <GroupBrowse client={client} session={session}>{(accountID, onAccessDenied) => accountID !== session.account.id
              ? <MemberCheckins client={client} session={session} accountID={accountID} onAccessDenied={onAccessDenied} />
              : <CampPage client={client} session={session} renderSidebar={(camp) => <>
                <AchievementStrip items={camp.earned_achievements ?? []} accountID={session.account.id} renderCharacter={(badgeToggle) =>
                  <CharacterPanel
                    username={camp.account.username}
                    reduceMotion={session.account.preferences.reduce_motion}
                    title={camp.achievement_title?.name ?? null}
                    onAchievements={() => navigate('achievements')}
                    badgeToggle={badgeToggle}
                  />
                } />
                <FamilyPanel client={client} session={session} />
              </>} />}
            </GroupBrowse>
          </>}
          {page === 'island' && <Suspense fallback={<section className="island-loading"><MainNavigation current="island" disabled={false} onNavigate={navigate} /><button className="secondary" onClick={() => navigate(islandReturnPage)}>{islandContent.back}</button><p role="status">{content.common.loading}</p></section>}>
            <IslandPage client={client} session={session} onNavigate={navigate} onCamp={() => navigate('camp')} onShop={openSceneShop} onBack={() => navigate(islandReturnPage)} onSettings={() => setSoundOpen(true)} />
          </Suspense>}
          {page === 'shop' && <ShopPage client={client} session={session} {...(shopInitialGroup ? { initialGroup: shopInitialGroup } : {})} onAppearance={() => navigate('appearance')} />}
          {page === 'appearance' && <AppearanceWorkspace client={client} session={session} leaveGuardRef={appearanceLeave} />}
          {page === 'achievements' && <AchievementPage client={client} session={session} />}
          {page === 'stats' && <GroupBrowse client={client} session={session}>{(accountID, onAccessDenied) => <ReportsPage client={client} session={session} accountID={accountID} onAccessDenied={onAccessDenied} />}</GroupBrowse>}
        </>}
        </div>
        {/* 设置隐藏时保留声音实例，普通页面只在进入配置后显示控件。 */}
        <SoundPreferences client={client} session={session} onPreferencesChange={acceptPreferences} presentation={management ? 'panel' : 'dialog'} open={immersive && soundOpen} onClose={() => setSoundOpen(false)} />
        {unlocking && <UnlockDialog client={client} onClose={() => setUnlocking(false)} onUnlock={(expiry) => { setUnlocking(false); setManagement(true); setManagementSection('account'); setExpiresAt(expiry); setNotice(''); }} />}
        {management && pendingLeave && <Modal title={content.account.discardTitle} onClose={() => setPendingLeave(null)}><div className="form-stack"><p>{content.account.discardHint}</p><div className="button-row"><button type="button" onClick={discardAccountDraft}>{content.account.discard}</button><button type="button" className="secondary" onClick={() => setPendingLeave(null)}>{content.account.keepEditing}</button></div></div></Modal>}
      </>}
    </MainContainer>
  </div></WalletProvider></AppearanceProvider>;
}
