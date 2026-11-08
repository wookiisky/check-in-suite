import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IslandApp } from './IslandApp';
import content from './content/zh-CN.json';
import { testSession } from './test/account-fixtures';
import { campFixture } from './features/checkin/test-fixtures';
import checkinContent from './features/checkin/content.json';
import achievementContent from './features/achievements/content.json';
import shopContent from './features/shop/content.json';
import islandContent from './features/island/three/spatial-content.json';
import sceneContent from './features/island/three/scene-picker-content.json';
import spatialConfiguration from '../../internal/island/spatial-scene.json';
import { appearanceFixture } from './features/shop/appearance-test-fixtures';
import appearanceContent from './features/shop/appearance-content.json';
import characterContent from './features/character/character-panel-content.json';
import { characterTestMatchMedia } from './features/character/character3d-preview-test-fixtures';
import familyContent from './features/family/content.json';
import { sound } from './features/family/sound-preferences-test-fakes';

vi.mock('./features/character/CharacterPreview3D',async()=>({CharacterPreview3D:(await import('./app-character-test-fixtures')).AppCharacterPreviewFake}));
vi.mock('./features/island/three/SpatialScene3D',()=>({SpatialScene3D:()=>null}));
vi.mock('./features/family/sound', async () => ({ SoundEngine: (await import('./features/family/sound-preferences-test-fakes')).SoundEngineFake }));

// 测试响应按真实账户协议组织，不复用演示账户。
function installServer(loggedIn = false, managementExpiry: string | null = null) {
  let active = loggedIn;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.endsWith('/session')) return active ? Response.json({ ...testSession, management_expires_at: managementExpiry }) : Response.json({ code: 'SESSION_REQUIRED', field_errors: {}, request_id: 'r1' }, { status: 401 });
    if (path.endsWith('/camp')) return Response.json(campFixture);
    if (path.endsWith('/appearance')) return Response.json(appearanceFixture());
    if (path.endsWith('/island/layout')) return Response.json({version:1,scene_key:spatialConfiguration.scene.scene_key,environment_key:'day',scene:spatialConfiguration.scene,catalog:spatialConfiguration.catalog,placements:spatialConfiguration.default_placements,inventory:spatialConfiguration.default_placements.map(item=>({instance_id:item.instance_id,item_key:item.item_key}))});
    if (path.endsWith('/island/activity-access')) return Response.json({today:'2026-11-01',expires_at:new Date(Date.now()+3_600_000).toISOString(),activity_access:[]});
    if (path.includes('/checkins?')) return Response.json({ items: [], next_cursor: null });
    if (path.endsWith('/achievements')) return Response.json({ items: [], title: null });
    if (path.includes('/messages')) return Response.json({ items: [], next_cursor: null });
    if (path.includes('/purchases')) return Response.json({ items: [], next_cursor: null });
    if (path.includes('/shop/products?')) return Response.json({ items: [], page: 1, total: 0, camp_categories: ['scene'], wallet: campFixture.wallet });
    if (path.includes('/products')) return Response.json({ items: [] });
    if (path.includes('/categories') || path.includes('/tasks')) return Response.json({ items: [] });
    if (path.endsWith('/auth/login')) { active = true; return Response.json(testSession); }
    if (path.endsWith('/management/unlock')) return Response.json({ management_expires_at: '2026-10-29T04:30:00Z' });
    if (path.endsWith('/auth/logout')) { active = false; return new Response(null, { status: 204 }); }
    if (path.endsWith('/management/lock')) return new Response(null, { status: 204 });
    if (path.endsWith('/account/profile')) return Response.json({ ...testSession.account, ...JSON.parse(String(init?.body)), version: 2 });
    if (path.endsWith('/account/preferences')) return Response.json({ ...testSession.account.preferences, ...JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// 管理入口始终要求当前这次输入密码。
async function unlock() {
  fireEvent.click(await screen.findByRole('button', { name: content.navigation.management }));
  fireEvent.change(screen.getByLabelText(content.account.managementPassword), { target: { value: 'Manage-Test-2026' } });
  fireEvent.click(screen.getByRole('button', { name: content.account.unlock }));
  await screen.findByRole('heading', { name: content.account.settingsTitle });
}

beforeEach(() => {vi.clearAllMocks();vi.stubGlobal('matchMedia',characterTestMatchMedia);});
afterEach(() => vi.unstubAllGlobals());

describe('账户页面与管理授权', () => {
  it('普通顶栏里的配置和退出是带可访问名称的图标按钮', async () => {
    installServer(true);
    render(<IslandApp />);
    await screen.findByRole('heading', { name: content.navigation.campTitle });
    const header = within(screen.getByRole('banner'));
    for (const name of [content.navigation.management, content.account.logout]) {
      const button = await header.findByRole('button', { name });
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg, img')).not.toBeNull();
    }
  });

  it.each(['section', 'navigation', 'brand', 'lock', 'logout'] as const)('账户姓名草稿在%s离开前确认，取消保留输入，放弃后再执行操作', async (target) => {
    const server = installServer(true);
    render(<IslandApp />);
    await unlock();
    fireEvent.change(screen.getByLabelText(content.account.displayName), { target: { value: '尚未保存的姓名' } });
    if (target === 'section') fireEvent.click(screen.getByRole('button', { name: content.navigation.tasks }));
    else if (target === 'navigation') fireEvent.click(screen.getByRole('button', { name: content.navigation.shop }));
    else if (target === 'brand') fireEvent.click(screen.getByRole('link', { name: content.appName }));
    else fireEvent.click(screen.getByRole('button', { name: target === 'lock' ? content.account.leaveManagement : content.account.logout }));
    const dialog = await screen.findByRole('dialog', { name: content.account.discardTitle });
    expect(screen.getByLabelText(content.account.displayName)).toHaveValue('尚未保存的姓名');
    expect(server.mock.calls.some(([path]) => /\/(management\/lock|auth\/logout)$/.test(String(path)))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: content.account.keepEditing }));
    expect(screen.getByLabelText(content.account.displayName)).toHaveValue('尚未保存的姓名');
    if (target === 'section') fireEvent.click(screen.getByRole('button', { name: content.navigation.tasks }));
    else if (target === 'navigation') fireEvent.click(screen.getByRole('button', { name: content.navigation.shop }));
    else if (target === 'brand') fireEvent.click(screen.getByRole('link', { name: content.appName }));
    else fireEvent.click(screen.getByRole('button', { name: target === 'lock' ? content.account.leaveManagement : content.account.logout }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: content.account.discardTitle })).getByRole('button', { name: content.account.discard }));
    await waitFor(() => expect(screen.queryByLabelText(content.account.displayName)).not.toBeInTheDocument());
    if (target === 'section') await screen.findByRole('button', { name: checkinContent.newTask });
    if (target === 'logout') await screen.findByRole('heading', { name: content.account.loginTitle });
  });

  it.each(['login', 'management'] as const)('%s密码草稿关闭确认后保留，刷新保护在草稿放弃后解除', async (kind) => {
    installServer(true);
    render(<IslandApp />);
    await unlock();
    fireEvent.change(screen.getByLabelText(content.account.newPassword, { selector: `#${kind}-new` }), { target: { value: 'Unsaved-Password-2026' } });
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: content.navigation.tasks }));
    const dialog = await screen.findByRole('dialog', { name: content.account.discardTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: content.common.close }));
    expect(screen.getByLabelText(content.account.newPassword, { selector: `#${kind}-new` })).toHaveValue('Unsaved-Password-2026');
    fireEvent.click(screen.getByRole('button', { name: content.navigation.tasks }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: content.account.discardTitle })).getByRole('button', { name: content.account.discard }));
    await screen.findByRole('button', { name: checkinContent.newTask });
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it('姓名保存进行中不能切换或退出，保存后直接离开而不要求放弃', async () => {
    const server = installServer(true);
    render(<IslandApp />);
    await unlock();
    fireEvent.change(screen.getByLabelText(content.account.displayName), { target: { value: '保存后的姓名' } });
    let complete!: (response: Response) => void;
    server.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: content.account.saveName }));
    fireEvent.click(screen.getByRole('button', { name: content.navigation.tasks }));
    fireEvent.click(screen.getByRole('button', { name: content.navigation.shop }));
    fireEvent.click(screen.getByRole('button', { name: content.account.leaveManagement }));
    fireEvent.click(screen.getByRole('button', { name: content.account.logout }));
    fireEvent.click(screen.getByRole('link', { name: content.appName }));
    expect(screen.getByLabelText(content.account.displayName)).toHaveValue('保存后的姓名');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => complete(Response.json({ ...testSession.account, display_name: '保存后的姓名', version: 2 })));
    await screen.findByText(content.account.nameSaved);
    fireEvent.click(screen.getByRole('button', { name: content.navigation.tasks }));
    await screen.findByRole('button', { name: checkinContent.newTask });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('密码提交期间保留表单，成功后即使有其他草稿也立即回到登录', async () => {
    const server = installServer(true);
    render(<IslandApp />);
    await unlock();
    fireEvent.change(screen.getByLabelText(content.account.displayName), { target: { value: '另一份未保存草稿' } });
    for (const [field, value] of [['old', 'Island-Test-2026'], ['new', 'New-Island-2026'], ['confirm', 'New-Island-2026']] as const) {
      fireEvent.change(document.querySelector(`#login-${field}`)!, { target: { value } });
    }
    let complete!: (response: Response) => void;
    server.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: content.account.changeLoginPassword }));
    expect(screen.getByRole('button', { name: content.navigation.tasks })).toBeDisabled();
    expect(screen.getByRole('button', { name: content.account.leaveManagement })).toBeDisabled();
    await act(async () => complete(new Response(null, { status: 204 })));
    await screen.findByRole('heading', { name: content.account.loginTitle });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(content.account.displayName)).not.toBeInTheDocument();
  });

  it('保存时管理权限失效仍立即隐藏草稿，不显示离开确认', async () => {
    const server = installServer(true);
    render(<IslandApp />);
    await unlock();
    fireEvent.change(screen.getByLabelText(content.account.displayName), { target: { value: '未保存的姓名' } });
    server.mockResolvedValueOnce(Response.json({ code: 'MANAGEMENT_REQUIRED', field_errors: {}, request_id: 'expired' }, { status: 403 }));
    fireEvent.click(screen.getByRole('button', { name: content.account.saveName }));
    await screen.findByText(content.account.managementExpired);
    expect(screen.queryByLabelText(content.account.displayName)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('声音设置仅在配置解锁后显示，退出后隐藏并保留已保存偏好', async () => {
    installServer(true);
    render(<IslandApp />);
    const opener = await screen.findByRole('button', { name: content.navigation.management });
    expect(within(screen.getByRole('main')).queryByRole('button', { name: content.navigation.management })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: familyContent.sounds })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(familyContent.music)).not.toBeInTheDocument();
    fireEvent.click(opener);
    expect(screen.getByLabelText(content.account.managementPassword)).toBeInTheDocument();
    expect(screen.queryByLabelText(familyContent.music)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.common.cancel }));
    await unlock();
    expect(screen.queryByRole('button', { name: content.navigation.management })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: familyContent.sounds })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(familyContent.reduceMotion));
    await waitFor(() => expect(screen.getByLabelText(familyContent.reduceMotion)).toBeEnabled());
    expect(screen.getByLabelText(familyContent.reduceMotion)).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: content.account.leaveManagement }));
    expect(screen.queryByLabelText(familyContent.music)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: content.navigation.management })).toBeEnabled());
    await unlock();
    expect(screen.getByLabelText(familyContent.reduceMotion)).toBeChecked();
  });

  it('退出配置不停止已播放的音乐，也不重建声音实例', async () => {
    const server = installServer(true);
    server.mockResolvedValueOnce(Response.json({ ...testSession, account: { ...testSession.account, preferences: { ...testSession.account.preferences, music_enabled: true } } }));
    render(<IslandApp />);
    await unlock();
    fireEvent.click(screen.getByRole('button', { name: familyContent.playMusic }));
    await waitFor(() => expect(sound.start).toHaveBeenCalledTimes(1));
    const stops = sound.stop.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: content.account.leaveManagement }));
    expect(screen.queryByLabelText(familyContent.music)).not.toBeInTheDocument();
    expect(sound.dispose).not.toHaveBeenCalled();
    expect(sound.stop).toHaveBeenCalledTimes(stops);
    await waitFor(() => expect(screen.getByRole('button', { name: content.navigation.management })).toBeEnabled());
    await unlock();
    expect(screen.getByRole('button', { name: familyContent.pauseMusic })).toBeInTheDocument();
    expect(sound.activate).toHaveBeenCalledTimes(1);
  });

  it('小岛设置按按钮打开，返回营地后设置仍隐藏', async () => {
    installServer(true);
    render(<IslandApp />);
    fireEvent.click(await screen.findByRole('button', { name: content.navigation.island }));
    fireEvent.click(await screen.findByRole('button', { name: islandContent.settings }));
    expect(screen.getByRole('dialog', { name: familyContent.sounds })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.common.close }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: islandContent.back }));
    await screen.findByRole('button', { name: content.navigation.management });
    expect(screen.queryByLabelText(familyContent.music)).not.toBeInTheDocument();
    expect(sound.dispose).not.toHaveBeenCalled();
  });

  it('营地标题栏保留五个入口，独立返回回到进入前页面', async () => {
    installServer(true);
    render(<IslandApp />);
    fireEvent.click(await screen.findByRole('button', { name: content.navigation.shop }));
    fireEvent.click(screen.getByRole('button', { name: content.navigation.island }));
    await screen.findByRole('region', { name: islandContent.scene });
    expect(screen.getAllByRole('main')).toHaveLength(1);
    const navigation = screen.getByRole('navigation', { name: content.navigation.label });
    expect(within(navigation).getAllByRole('button').map((item) => item.textContent)).toEqual(['打卡', '营地', '统计', '商店', '装扮']);
    expect(within(navigation).getByRole('button', { name: '营地' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: content.navigation.management })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: islandContent.back }));
    await screen.findByRole('tablist', { name: shopContent.categoryGroupLabel });
    expect(screen.getByRole('button', { name: content.navigation.shop })).toHaveAttribute('aria-current', 'page');
  });

  it('小岛入口随会话展示，未进入时不读取岛屿布局', async () => {
    const server = installServer(true);
    render(<IslandApp />);
    await screen.findByRole('button', { name: content.navigation.island });
    expect(server.mock.calls.some(([path]) => String(path).endsWith('/island/layout'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: content.account.logout }));
    await screen.findByRole('heading', { name: content.account.loginTitle });
    expect(screen.queryByRole('button', { name: content.navigation.island })).not.toBeInTheDocument();
  });

  it('未登录时填写真实凭据，登录成功后显示账户，退出后清除内容', async () => {
    const server = installServer();
    render(<IslandApp />);
    fireEvent.change(await screen.findByLabelText(content.account.username), { target: { value: 'island-e2e' } });
    fireEvent.change(screen.getByLabelText(content.account.loginPassword), { target: { value: 'Island-Test-2026' } });
    fireEvent.click(screen.getByRole('button', { name: content.account.login }));
    await screen.findByRole('button', { name: content.account.logout });
    expect(server).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({ method: 'POST', body: JSON.stringify({ username: 'island-e2e', password: 'Island-Test-2026' }) }));
    fireEvent.click(screen.getByRole('button', { name: content.account.logout }));
    await screen.findByRole('heading', { name: content.account.loginTitle });
    expect(screen.queryByText(testSession.account.display_name)).not.toBeInTheDocument();
  });

  it('已有管理授权也不自动展示管理页，退出后再次进入须重新输入密码', async () => {
    const server = installServer(true, '2026-10-29T04:30:00Z');
    render(<IslandApp />);
    expect(screen.queryByRole('heading', { name: content.account.settingsTitle })).not.toBeInTheDocument();
    await unlock();
    fireEvent.click(screen.getByRole('button', { name: content.account.leaveManagement }));
    await waitFor(() => expect(server).toHaveBeenCalledWith('/api/v1/management/lock', expect.objectContaining({ method: 'POST', headers: expect.any(Headers) })));
    fireEvent.click(screen.getByRole('button', { name: content.navigation.management }));
    expect(screen.getByLabelText(content.account.managementPassword)).toHaveValue('');
    expect(screen.queryByRole('heading', { name: content.account.settingsTitle })).not.toBeInTheDocument();
  });

  it('退出管理请求失败也立即隐藏管理内容，显示可重试的未确认状态', async () => {
    const server = installServer(true);
    render(<IslandApp />);
    await unlock();
    server.mockRejectedValueOnce(new TypeError('offline'));
    fireEvent.click(screen.getByRole('button', { name: content.account.leaveManagement }));
    expect(screen.queryByRole('heading', { name: content.account.settingsTitle })).not.toBeInTheDocument();
    await screen.findByText(content.account.lockUnconfirmed);
    fireEvent.click(screen.getByRole('button', { name: content.account.retryLock }));
    await waitFor(() => expect(screen.queryByText(content.account.lockUnconfirmed)).not.toBeInTheDocument());
  });

  it('服务端字段错误保留姓名草稿并显示字段提示', async () => {
    const server = installServer(true);
    render(<IslandApp />);
    await unlock();
    fireEvent.change(screen.getByLabelText(content.account.displayName), { target: { value: '新名字' } });
    server.mockResolvedValueOnce(Response.json({ code: 'INVALID_REQUEST', field_errors: { display_name: 'TOO_LONG' }, request_id: 'r2' }, { status: 400 }));
    fireEvent.click(screen.getByRole('button', { name: content.account.saveName }));
    await screen.findByText(content.errors.TOO_LONG);
    expect(screen.getByLabelText(content.account.displayName)).toHaveValue('新名字');
  });

  it('姓名保存响应丢失后的版本冲突保留草稿，加载最新资料并明确确认后才能重试', async () => {
    const server = installServer(true);
    render(<IslandApp />);
    await unlock();
    fireEvent.change(screen.getByLabelText(content.account.displayName), { target: { value: '我想保存的姓名' } });
    server.mockRejectedValueOnce(new TypeError('response lost'));
    fireEvent.click(screen.getByRole('button', { name: content.account.saveName }));
    await screen.findByText(content.errors.NETWORK_ERROR);
    server.mockResolvedValueOnce(Response.json({ code: 'VERSION_CONFLICT', field_errors: {}, request_id: 'r3', current_version: 2 }, { status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: content.account.saveName }));
    await screen.findByText(content.account.nameConflictHint);
    expect(screen.getByRole('button', { name: content.account.saveName })).toBeDisabled();
    expect(screen.getByLabelText(content.account.displayName)).toHaveValue('我想保存的姓名');
    server.mockRejectedValueOnce(new TypeError('reload offline'));
    fireEvent.click(screen.getByRole('button', { name: content.account.reloadProfile }));
    await screen.findByText(content.errors.NETWORK_ERROR);
    expect(screen.getByRole('button', { name: content.account.saveName })).toBeDisabled();
    expect(screen.getByLabelText(content.account.displayName)).toHaveValue('我想保存的姓名');
    const latest = { ...testSession, account: { ...testSession.account, display_name: '其他已保存的姓名', version: 2 } };
    server.mockResolvedValueOnce(Response.json(latest));
    fireEvent.click(screen.getByRole('button', { name: content.account.reloadProfile }));
    await screen.findByText(content.account.nameReviewHint);
    expect(screen.getByLabelText(content.account.displayName)).toHaveValue('我想保存的姓名');
    expect(screen.getAllByText('其他已保存的姓名').length).toBeGreaterThan(0);
    const writeCount = server.mock.calls.filter(([path]) => String(path).endsWith('/account/profile')).length;
    expect(writeCount).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: content.account.confirmNameDraft }));
    await screen.findByText(content.account.nameSaved);
    expect(server.mock.calls.filter(([path]) => String(path).endsWith('/account/profile')).at(-1)?.[1]?.body).toBe(JSON.stringify({ display_name: '我想保存的姓名', expected_version: 2 }));
  });

  it('修改密码成功后返回登录，密码确认不一致时不发送请求', async () => {
    const server = installServer(true);
    render(<IslandApp />);
    await unlock();
    fireEvent.change(screen.getByLabelText(content.account.oldPassword, { selector: '#login-old' }), { target: { value: 'Island-Test-2026' } });
    fireEvent.change(screen.getByLabelText(content.account.newPassword, { selector: '#login-new' }), { target: { value: 'New-Island-2026' } });
    fireEvent.change(screen.getByLabelText(content.account.confirmPassword, { selector: '#login-confirm' }), { target: { value: 'Different-2026' } });
    fireEvent.click(screen.getByRole('button', { name: content.account.changeLoginPassword }));
    await screen.findByText(content.errors.PASSWORD_MISMATCH);
    expect(server.mock.calls.some(([path]) => String(path).endsWith('/account/login-password'))).toBe(false);
    fireEvent.change(screen.getByLabelText(content.account.confirmPassword, { selector: '#login-confirm' }), { target: { value: 'New-Island-2026' } });
    fireEvent.click(screen.getByRole('button', { name: content.account.changeLoginPassword }));
    await screen.findByRole('heading', { name: content.account.loginTitle });
  });

  it('营地和管理四组导航使用真实模块，组内切换不退出授权，返回营地才锁定', async () => {
    const server = installServer(true);
    render(<IslandApp />);
    await screen.findByRole('heading', { name: checkinContent.todayTasks });
    await unlock();
    fireEvent.click(screen.getByRole('button', { name: content.navigation.tasks }));
    await screen.findByRole('button', { name: checkinContent.newTask });
    expect(server.mock.calls.filter(([path]) => String(path).endsWith('/management/lock'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: content.navigation.records }));
    await screen.findByRole('heading', { name: checkinContent.manageRecords });
    fireEvent.click(screen.getByRole('button', { name: content.navigation.products }));
    await screen.findByRole('button', { name: shopContent.addProduct });
    expect(server.mock.calls.filter(([path]) => String(path).endsWith('/management/lock'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: content.navigation.shop }));
    await screen.findByRole('tablist', { name: shopContent.categoryGroupLabel });
    fireEvent.click(screen.getByRole('button', { name: content.navigation.camp }));
    await screen.findByRole('heading', { name: checkinContent.todayTasks });
    await waitFor(() => expect(server.mock.calls.filter(([path]) => String(path).endsWith('/management/lock'))).toHaveLength(1));
  });

  it('关闭管理密码弹窗后焦点返回入口，初次读取卸载后取消请求', async () => {
    installServer(true);
    const { unmount } = render(<IslandApp />);
    const opener = await screen.findByRole('button', { name: content.navigation.management });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: content.common.cancel }));
    expect(opener).toHaveFocus();
    unmount();
    const pending = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', pending);
    const second = render(<IslandApp />);
    const signal = pending.mock.calls[0]?.[1]?.signal;
    await act(async () => second.unmount());
    expect(signal?.aborted).toBe(true);
  });
});


describe('打卡与装扮入口', () => {
  it('标题栏和人物区只显示登录用户名，人物区用图标进入成就', async () => {
    installServer(true);
    render(<IslandApp />);
    const navigation = await screen.findByRole('navigation', { name: content.navigation.label });
    expect(screen.getByRole('banner')).toContainElement(navigation);
    expect(within(navigation).getAllByRole('button').map((item) => item.textContent)).toEqual(['打卡', '营地', '统计', '商店', '装扮']);
    const character = await screen.findByRole('region', { name: characterContent.label });
    expect(within(character).getByRole('heading', { name: testSession.account.username })).toBeInTheDocument();
    expect(screen.queryByText(testSession.account.display_name)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: shopContent.backpack })).not.toBeInTheDocument();
    const achievement = within(character).getByRole('button', { name: content.navigation.achievements });
    expect(achievement).toHaveTextContent(/^$/);
    fireEvent.click(achievement);
    await screen.findByRole('heading', { name: achievementContent.title });
    fireEvent.click(within(navigation).getByRole('button', { name: '装扮' }));
    await screen.findByRole('heading', { name: appearanceContent.pageTitle });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('从营地场景选择打开已购买场景', async () => {
    localStorage.clear();
    const server = installServer(true), original = server.getMockImplementation()!;
    server.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith('/island/scenes')) return Response.json({ items: [
        { scene_key: 'seaside-v1', name: '海边营地', thumbnail_url: '/sea.png', free: true, owned: true },
        { scene_key: 'forest-courtyard-v1', name: '林间草地庭院', thumbnail_url: '/forest.png', free: false, owned: true },
      ] });
      if (path.includes('/island/layout?scene_key=forest-courtyard-v1')) return Response.json({
        version: 1, scene_key: 'forest-courtyard-v1', environment_key: 'day',
        scene: { ...spatialConfiguration.scene, scene_key: 'forest-courtyard-v1', house: null },
        catalog: spatialConfiguration.catalog, placements: [], inventory: [],
      });
      return original(input, init);
    });
    try {
      render(<IslandApp />);
      fireEvent.click(await screen.findByRole('button', { name: content.navigation.island }));
      await screen.findByRole('heading', { name: '海边营地' });
      fireEvent.click(screen.getByRole('button', { name: sceneContent.open }));
      fireEvent.click(await screen.findByRole('button', { name: sceneContent.go.replace('{name}', '林间草地庭院') }));
      await screen.findByRole('heading', { name: '林间草地庭院' });
    } finally { localStorage.clear(); }
  });
});

it('普通页面与管理界面共用全局钱包，营地隐藏，返回后保留余额', async () => {
  installServer(true);
  render(<IslandApp />);
  const wallet = await screen.findByRole('region', { name: shopContent.balance });
  expect(wallet).toHaveClass('global-wallet');
  expect(document.querySelector('.checkin-wallet')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: content.navigation.shop }));
  await screen.findByRole('tablist', { name: shopContent.categoryGroupLabel });
  expect(screen.getByRole('region', { name: shopContent.balance })).toBe(wallet);
  expect(document.querySelector('.shop-wallet')).toBeNull();
  expect(screen.getByRole('region', { name: shopContent.balance })).toBe(wallet);
  fireEvent.click(screen.getByRole('button', { name: content.navigation.island }));
  await screen.findByRole('heading', { name: islandContent.title });
  expect(document.querySelector('.global-wallet')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: islandContent.back }));
  await screen.findByRole('tablist', { name: shopContent.categoryGroupLabel });
  expect(document.querySelectorAll('.global-wallet')).toHaveLength(1);
  await unlock();
  expect(document.querySelectorAll('.global-wallet')).toHaveLength(1);
});

it('换账户隔离草稿和未知打卡，原账户重登仍可恢复', async () => {
  const server = installServer(true);
  const original = server.getMockImplementation()!;
  let currentAccount = testSession.account;
  server.mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.endsWith('/groups')) return Response.json({ groups: [], current_group: null, members: [] });
    if (path.endsWith('/auth/login')) {
      await original(input, init);
      const username = JSON.parse(String(init?.body)).username;
      currentAccount = username === 'second-user' ? { ...testSession.account, id: 2, username, display_name: '第二位小朋友' } : testSession.account;
      return Response.json({ ...testSession, account: currentAccount, csrf_token: `csrf-${currentAccount.id}` });
    }
    if (path.endsWith('/camp')) return Response.json({ ...campFixture, account: currentAccount });
    return original(input, init);
  });
  render(<IslandApp />);
  fireEvent.change(await screen.findByLabelText(familyContent.input), { target: { value: '只属于第一位小朋友的草稿' } });
  fireEvent.click(await screen.findByRole('button', { name: /阅读.*金币/ }));
  fireEvent.click(screen.getByRole('button', { name: checkinContent.checkin }));
  await screen.findByText(checkinContent.unknownResult);
  fireEvent.click(screen.getByRole('button', { name: checkinContent.close }));
  expect(screen.getByText(checkinContent.pendingBanner)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: content.account.logout }));
  fireEvent.change(await screen.findByLabelText(content.account.username), { target: { value: 'second-user' } });
  fireEvent.change(screen.getByLabelText(content.account.loginPassword), { target: { value: 'Island-Test-2026' } });
  fireEvent.click(screen.getByRole('button', { name: content.account.login }));
  expect(await screen.findByLabelText(familyContent.input)).toHaveValue('');
  expect(screen.queryByText(checkinContent.pendingBanner)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: content.account.logout }));
  fireEvent.change(await screen.findByLabelText(content.account.username), { target: { value: testSession.account.username } });
  fireEvent.change(screen.getByLabelText(content.account.loginPassword), { target: { value: 'Island-Test-2026' } });
  fireEvent.click(screen.getByRole('button', { name: content.account.login }));
  expect(await screen.findByLabelText(familyContent.input)).toHaveValue('只属于第一位小朋友的草稿');
  expect(screen.getByText(checkinContent.pendingBanner)).toBeInTheDocument();
});
