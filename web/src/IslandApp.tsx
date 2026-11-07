import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiClient, ApiFailure, errorMessage } from './api/client';
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
import { GroupBrowse } from './features/groups/GroupBrowse';
import { MemberCheckins } from './features/groups/MemberCheckins';
import { CheckinManagement } from './features/checkin/CheckinManagement';
import { ShopPage } from './features/shop/ShopPage';
import { BackpackPage } from './features/shop/BackpackPage';
import { AppearanceDialog } from './features/shop/AppearanceDialog';
import { AppearanceProvider, useAppearance } from './features/character/AppearanceProvider';
import { TitlePicker } from './features/character/TitlePicker';
import type { Camp, Equipment } from './features/shop/types';
import { ProductManagement } from './features/shop/ProductManagement';
import { CalendarPage } from './features/reports/CalendarPage';
import { StatsPage } from './features/reports/StatsPage';
import { CharacterPanel } from './features/character/CharacterPanel';
import { FamilyPanel } from './features/family/FamilyPanel';
import { AchievementPage } from './features/achievements/AchievementPage';
import { AchievementManagement } from './features/achievements/AchievementManagement';
import { AchievementStrip } from './features/achievements/AchievementStrip';
import { SoundPreferences } from './features/family/SoundPreferences';
import content from './content/zh-CN.json';
import islandContent from './features/island/three/spatial-content.json';
import titleContent from './features/character/title-picker-content.json';
import shopContent from './features/shop/content.json';

// 小岛素材与活动代码只在进入页面时加载。
const IslandPage = lazy(() => import('./features/island/IslandPage3D').then((module) => ({ default: module.IslandPage3D })));

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


// 外观弹窗与业务页面互为兄弟节点，共享发布不会重挂任务或留言。
function AppearanceOverlay({client,session,onClose}:{client:ApiClient;session:Session;onClose:()=>void}){
  const {publishSaved}=useAppearance();
  return <AppearanceDialog client={client} reduceMotion={session.account.preferences.reduce_motion} onClose={onClose} onSaved={publishSaved}/>;
}

// 观察已存在的营地快照，不为全局称号入口重复读取聚合数据。
function CampEquipmentObserver({equipment,updateEquipment,onCurrent}:{equipment:Equipment;updateEquipment:(equipment:Equipment)=>void;onCurrent:(equipment:Equipment,recipient:((equipment:Equipment)=>void)|null)=>void}){
  useLayoutEffect(()=>{onCurrent(equipment,updateEquipment);return()=>onCurrent(equipment,null);},[equipment,updateEquipment,onCurrent]);
  return null;
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
  const [islandInitialScene, setIslandInitialScene] = useState<string | undefined>(); // 只传递本次明确选择的目的地。
  const [soundOpen, setSoundOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [management, setManagement] = useState(false);
  const [managementSection, setManagementSection] = useState<ManagementSection>('account');
  const [accountForm, setAccountForm] = useState<AccountFormState>({ dirty: false, pending: false });
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [lockPending, setLockPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const serverOffset = useRef(0);
  const equipmentCache=useRef<Equipment|null>(null); // 最近已确认的称号快照。
  const equipmentRecipient=useRef<((equipment:Equipment)=>void)|null>(null); // 只回写当前挂载的首页。
  const [titleEditor,setTitleEditor]=useState<Equipment|null>(null);
  const [titleLoading,setTitleLoading]=useState(false);
  const [titleReadError,setTitleReadError]=useState<unknown>(null);
  const titleRequest=useRef<AbortController|null>(null); // 只取消尚未打开称号选择器前的聚合读取。
  const titleGeneration=useRef(0); // 导航或新会话使迟到读取失效。
  const rememberEquipment=useCallback((equipment:Equipment,recipient:((equipment:Equipment)=>void)|null)=>{equipmentCache.current=equipment;equipmentRecipient.current=recipient;},[]);
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

  // 登录会话切换清除旧入口和读取，外观版本更新不会触发此清理。
  useEffect(()=>{
    titleGeneration.current+=1;titleRequest.current?.abort();equipmentCache.current=null;equipmentRecipient.current=null;
    setAppearanceOpen(false);setTitleEditor(null);setTitleLoading(false);setTitleReadError(null);
    return()=>{titleGeneration.current+=1;titleRequest.current?.abort();};
  },[session?.csrf_token]);

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
    titleGeneration.current += 1;
    client.setCsrfToken(value.csrf_token); client.recordServerTime(value.server_now); serverOffset.current = Date.parse(value.server_now) - Date.now();
    setSession(value); setAppearanceOpen(false);setTitleEditor(null);equipmentCache.current=null;titleRequest.current?.abort(); setNotice(''); setManagement(false); setLockPending(false); setPage('camp');
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
  // 每次打开四槽编辑器读取独立外观，成功由Provider直接发布。
  function openAppearance() {titleGeneration.current+=1;titleRequest.current?.abort();setTitleLoading(false);setTitleReadError(null);setNotice('');setTitleEditor(null);setAppearanceOpen(true);}

  // 背包冷启动缺少快照时才显式读取；失败不伪造一个空称号。
  async function openTitle(equipment?:Equipment,recipient?:((equipment:Equipment)=>void)){
    titleRequest.current?.abort();const generation=++titleGeneration.current;
    setAppearanceOpen(false);setTitleReadError(null);
    if(equipment){equipmentCache.current=equipment;equipmentRecipient.current=recipient??null;}
    const known=equipment??equipmentCache.current;
    if(known){setTitleEditor(known);setTitleLoading(false);return;}
    const request=new AbortController();titleRequest.current=request;setTitleLoading(true);
    try{
      const snapshot=await client.request<Camp>('/camp',{signal:request.signal});
      if(request.signal.aborted||generation!==titleGeneration.current)return;
      equipmentCache.current=snapshot.equipment;setTitleEditor(snapshot.equipment);
    }catch(reason){if(!request.signal.aborted&&generation===titleGeneration.current)setTitleReadError(reason);}
    finally{if(!request.signal.aborted&&generation===titleGeneration.current)setTitleLoading(false);}
  }
  function titleSaved(equipment:Equipment){equipmentCache.current=equipment;equipmentRecipient.current?.(equipment);setTitleEditor(equipment);}
  function navigate(next: Page) {
    setIslandInitialScene(undefined);
    titleGeneration.current += 1;titleRequest.current?.abort();setTitleEditor(null);setTitleLoading(false);setTitleReadError(null);
    if (next === 'island' && page !== 'island') setIslandReturnPage(management ? 'camp' : page);
    if (next === 'shop') setShopInitialGroup(undefined);
    setSoundOpen(false); setAppearanceOpen(false); setPage(next);
    if (management) void lock();
  }
  // 场景购买入口保留商店分类；实际进入资格仍由服务端和营地页复核。
  function openSceneShop(group?: 'scene') {
    navigate('shop');
    setShopInitialGroup(group);
  }
  // 明确目的地属于本次导航；营地核对资格后再记录本机偏好。
  function openIsland(sceneKey?: string) {
    navigate('island');
    setIslandInitialScene(sceneKey);
  }
  async function logout() {
    setBusy(true); setError(null); setManagement(false); setUnlocking(false);
    try {
      await client.request<void>('/auth/logout', { method: 'POST' });
      setSession(null);setAppearanceOpen(false);setTitleEditor(null);equipmentCache.current=null; client.setCsrfToken(''); setNotice(''); setLockPending(false);
    } catch (reason) { setError(reason); setNotice(content.account.logoutUnconfirmed); }
    finally { setBusy(false); }
  }
  function passwordChanged() {
    setSession(null); setManagement(false); setExpiresAt(null); client.setCsrfToken(''); setNotice(content.account.passwordChanged);
  }

  return <AppearanceProvider key={session?.csrf_token ?? 'signed-out'} client={client} active={session!==null}><WalletProvider key={session?.csrf_token ?? 'signed-out'} client={client} active={session !== null}><div className={`application ${immersive ? 'application-island' : ''}`}>
    {!immersive && <div className="global-wallet-bar"><div className="global-wallet-bar-inner">
      <a className="brand" href="#" aria-disabled={accountSaving || undefined} onClick={(event) => { event.preventDefault(); leaveAccount(() => navigate('camp')); }}><svg aria-hidden="true" viewBox="0 0 48 48"><path fill="#628643" d="M24 3 7 28h11L9 39h30l-9-11h11z"/><path fill="#865b19" d="M21 37h6v9h-6z"/></svg><strong>{content.appName}</strong></a>
      {session && <GlobalWallet reduceMotion={session.account.preferences.reduce_motion} />}
    </div></div>}
    {!immersive && session && <header className="site-header"><div className="header-inner">
      {session && <><nav aria-label={content.navigation.label}>{(['camp', 'island', 'calendar', 'stats', 'shop', 'achievements'] as const).map((item) => <button key={item} className={`nav-button ${!management && page === item ? 'active' : ''}`} aria-current={!management && page === item ? 'page' : undefined} disabled={accountSaving} onClick={() => leaveAccount(() => navigate(item))}><img src={`/api/v1/assets/${navIcons[item]}`} alt="" aria-hidden="true" /><span>{content.navigation[item]}</span></button>)}</nav><div className="account-tools"><span className="name-chip"><img src="/api/v1/assets/user-v1" alt="" aria-hidden="true" /><span>{session.account.display_name}</span></span><button className="secondary" disabled={busy || accountSaving} onClick={() => leaveAccount(() => void logout())}>{content.account.logout}</button>{!management && <button className="secondary header-management-entry" disabled={lockPending} onClick={(event) => { event.currentTarget.focus(); setNotice(''); setUnlocking(true); }}><img src="/api/v1/assets/settings-v1" alt="" aria-hidden="true" /><span>{content.navigation.management}</span></button>}</div></>}
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
            <h1 className="page-heading">{content.navigation.camp}</h1>
            <GroupBrowse client={client} session={session}>{(accountID, onAccessDenied) => accountID !== session.account.id ? <MemberCheckins client={client} session={session} accountID={accountID} onAccessDenied={onAccessDenied} /> : <CampPage client={client} session={session} renderSidebar={(camp, updateEquipment) => <>
              <CampEquipmentObserver equipment={camp.equipment} updateEquipment={updateEquipment} onCurrent={rememberEquipment}/>
              <section className="camp-character-panel">
                <CharacterPanel equipment={camp.equipment} displayName={camp.account.display_name} reduceMotion={session.account.preferences.reduce_motion} onAppearance={openAppearance} onTitle={()=>void openTitle(camp.equipment,updateEquipment)}/>
                <div className="camp-character-actions"><button type="button" className="secondary" onClick={()=>navigate('backpack')}><img src="/api/v1/assets/icon-backpack-v1" alt="" aria-hidden="true"/><span>{shopContent.backpack}</span></button></div>
              </section>
              <AchievementStrip items={camp.achievements} onViewAll={() => navigate('achievements')} />
              <FamilyPanel client={client} session={session} />
            </>} />}</GroupBrowse>
          </>}
          {page === 'island' && <Suspense fallback={<section className="island-loading"><button className="secondary" onClick={() => navigate(islandReturnPage)}>{islandContent.back}</button><p role="status">{content.common.loading}</p></section>}><IslandPage client={client} session={session} {...(islandInitialScene ? { initialSceneKey: islandInitialScene } : {})} onCamp={() => navigate('camp')} onShop={openSceneShop} onBack={() => navigate(islandReturnPage)} onSettings={() => setSoundOpen(true)} /></Suspense>}
          {page === 'shop' && <ShopPage client={client} session={session} {...(shopInitialGroup ? { initialGroup: shopInitialGroup } : {})} onBackpack={() => navigate('backpack')} />}
          {page === 'backpack' && <BackpackPage client={client} session={session} onBack={() => navigate('camp')} onIsland={openIsland} onAppearance={openAppearance} onTitle={()=>void openTitle()} />}
          {page === 'achievements' && <AchievementPage client={client} session={session} />}
          {page === 'calendar' && <GroupBrowse client={client} session={session}>{(accountID, onAccessDenied) => <CalendarPage client={client} session={session} accountID={accountID} onAccessDenied={onAccessDenied} />}</GroupBrowse>}
          {page === 'stats' && <GroupBrowse client={client} session={session}>{(accountID, onAccessDenied) => <StatsPage client={client} session={session} accountID={accountID} onAccessDenied={onAccessDenied} />}</GroupBrowse>}
        </>}
        </div>
        {appearanceOpen&&<AppearanceOverlay client={client} session={session} onClose={()=>setAppearanceOpen(false)}/>}
        {titleEditor&&<TitlePicker client={client} equipment={titleEditor} onClose={()=>setTitleEditor(null)} onSaved={titleSaved}/>}
        {titleLoading&&<p role="status">{titleContent.loading}</p>}
        {titleReadError!==null&&<div role="alert"><p>{errorMessage(titleReadError)}</p><button onClick={()=>void openTitle()}>{titleContent.retry}</button></div>}
        {/* 设置隐藏时保留声音实例，普通页面只在进入配置后显示控件。 */}
        <SoundPreferences client={client} session={session} onPreferencesChange={acceptPreferences} presentation={management ? 'panel' : 'dialog'} open={immersive && soundOpen} onClose={() => setSoundOpen(false)} />
        {unlocking && <UnlockDialog client={client} onClose={() => setUnlocking(false)} onUnlock={(expiry) => { setUnlocking(false); setManagement(true); setManagementSection('account'); setExpiresAt(expiry); setNotice(''); }} />}
        {management && pendingLeave && <Modal title={content.account.discardTitle} onClose={() => setPendingLeave(null)}><div className="form-stack"><p>{content.account.discardHint}</p><div className="button-row"><button type="button" onClick={discardAccountDraft}>{content.account.discard}</button><button type="button" className="secondary" onClick={() => setPendingLeave(null)}>{content.account.keepEditing}</button></div></div></Modal>}
      </>}
    </MainContainer>
  </div></WalletProvider></AppearanceProvider>;
}
