import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IslandApp } from './IslandApp';
import content from './content/zh-CN.json';
import { testSession } from './test/account-fixtures';
import { campFixture } from './features/checkin/test-fixtures';
import checkinContent from './features/checkin/content.json';
import shopContent from './features/shop/content.json';
import islandContent from './features/island/content.json';
import { state as islandState } from './features/island/island-test-fixtures';
import familyContent from './features/family/content.json';
import { sound } from './features/family/sound-preferences-test-fakes';

vi.mock('./features/family/sound', async () => ({ SoundEngine: (await import('./features/family/sound-preferences-test-fakes')).SoundEngineFake }));

// 测试响应按真实账户协议组织，不复用演示账户。
function installServer(loggedIn = false, managementExpiry: string | null = null) {
  let active = loggedIn;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.endsWith('/session')) return active ? Response.json({ ...testSession, management_expires_at: managementExpiry }) : Response.json({ code: 'SESSION_REQUIRED', field_errors: {}, request_id: 'r1' }, { status: 401 });
    if (path.endsWith('/camp')) return Response.json(campFixture);
    if (path.endsWith('/island')) return Response.json(islandState);
    if (path.includes('/checkins?')) return Response.json({ items: [], next_cursor: null });
    if (path.includes('/messages')) return Response.json({ items: [], next_cursor: null });
    if (path.includes('/purchases')) return Response.json({ items: [], next_cursor: null });
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

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('账户页面与管理授权', () => {
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
    expect(within(screen.getByRole('banner')).getByRole('button', { name: content.navigation.management })).toBe(opener);
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

  it('进入小岛隐藏普通页框，独立返回回到进入前页面', async () => {
    installServer(true);
    render(<IslandApp />);
    fireEvent.click(await screen.findByRole('button', { name: content.navigation.shop }));
    fireEvent.click(screen.getByRole('button', { name: content.navigation.island }));
    await screen.findByRole('group', { name: islandContent.scene });
    expect(screen.queryByRole('navigation', { name: content.navigation.label })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: content.navigation.management })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: islandContent.back }));
    await screen.findByRole('heading', { name: shopContent.title });
    expect(screen.getByRole('button', { name: content.navigation.shop })).toHaveAttribute('aria-current', 'page');
  });

  it('小岛入口随会话展示，未进入时不读取岛屿布局', async () => {
    const server = installServer(true);
    render(<IslandApp />);
    await screen.findByRole('button', { name: content.navigation.island });
    expect(server.mock.calls.some(([path]) => String(path).endsWith('/island'))).toBe(false);
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
    await screen.findByRole('heading', { name: shopContent.title });
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


describe('背包与形象入口', () => {
  it('首页分别进入背包页面和装扮弹窗，关闭装扮保留留言草稿', async () => {
    installServer(true);
    render(<IslandApp />);
    const opener = await screen.findByRole('button', { name: shopContent.wardrobeTitle });
    fireEvent.change(screen.getByLabelText(familyContent.input), { target: { value: '保留这份留言' } });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: shopContent.wardrobeTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: content.common.close }));
    expect(screen.getByLabelText(familyContent.input)).toHaveValue('保留这份留言');
    expect(opener).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: shopContent.backpack }));
    await screen.findByRole('heading', { name: shopContent.backpack });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: shopContent.backHome }));
    await screen.findByRole('heading', { name: content.navigation.camp });
  });

  it('装扮保存后更新首页角色，不重新挂载任务或留言', async () => {
    const server = installServer(true);
    const original = server.getMockImplementation()!;
    let equipment = campFixture.equipment;
    server.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/equipment/base-avatar')) {
        equipment = { ...equipment, base_avatar_key: 'avatar-girl-v2' };
        return Response.json(equipment);
      }
      if (String(input).endsWith('/camp')) return Response.json({ ...campFixture, equipment });
      return original(input, init);
    });
    render(<IslandApp />);
    fireEvent.change(await screen.findByLabelText(familyContent.input), { target: { value: '换装前的留言' } });
    const messageField = screen.getByLabelText(familyContent.input);
    const taskButton = screen.getByRole('button', { name: /阅读/ });
    fireEvent.click(screen.getByRole('button', { name: shopContent.wardrobeTitle }));
    const dialog = await screen.findByRole('dialog', { name: shopContent.wardrobeTitle });
    fireEvent.click(await within(dialog).findByRole('button', { name: /女孩/ }));
    await within(dialog).findByText(shopContent.equipmentSaved);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /女孩/ })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: content.common.close }));
    expect(document.querySelector('.shop-character [data-base-avatar]')).toHaveAttribute('data-base-avatar', 'avatar-girl-v2');
    expect(screen.getByLabelText(familyContent.input)).toBe(messageField);
    expect(messageField).toHaveValue('换装前的留言');
    expect(screen.getByRole('button', { name: /阅读/ })).toBe(taskButton);
  });
});


it('装扮写成功后连续读取失败，重新打开读取成功即可恢复首页角色', async () => {
  const server = installServer(true);
  const original = server.getMockImplementation()!;
  let equipment = campFixture.equipment;
  let failures = 0;
  server.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/equipment/base-avatar')) {
      equipment = { ...equipment, base_avatar_key: 'avatar-girl-v2' };
      failures = 2;
      return Response.json(equipment);
    }
    if (String(input).endsWith('/camp')) {
      if (failures > 0) { failures -= 1; throw new TypeError('读取暂时不可用'); }
      return Response.json({ ...campFixture, equipment });
    }
    return original(input, init);
  });
  render(<IslandApp />);
  fireEvent.click(await screen.findByRole('button', { name: shopContent.wardrobeTitle }));
  let dialog = await screen.findByRole('dialog', { name: shopContent.wardrobeTitle });
  fireEvent.click(await within(dialog).findByRole('button', { name: /女孩/ }));
  await within(dialog).findByRole('alert');
  fireEvent.click(within(dialog).getByRole('button', { name: content.common.close }));
  await screen.findByText(shopContent.equipmentRefreshFailed);
  fireEvent.click(screen.getByRole('button', { name: shopContent.wardrobeTitle }));
  dialog = await screen.findByRole('dialog', { name: shopContent.wardrobeTitle });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: /女孩/ })).toHaveAttribute('aria-pressed', 'true'));
  fireEvent.click(within(dialog).getByRole('button', { name: content.common.close }));
  expect(document.querySelector('.checkin-sidebar [data-base-avatar]')).toHaveAttribute('data-base-avatar', 'avatar-girl-v2');
});


it('关闭后的慢速装备补读不能覆盖重开弹窗后保存的新形象', async () => {
  const server = installServer(true);
  const original = server.getMockImplementation()!;
  let equipment = campFixture.equipment;
  let firstSave = true;
  let failNext = false;
  let slowNext = false;
  let complete!: (response: Response) => void;
  server.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/equipment/base-avatar')) {
      const body = JSON.parse(String(init?.body)) as { asset_key: string };
      equipment = { ...equipment, base_avatar_key: body.asset_key };
      if (firstSave) { firstSave = false; failNext = true; }
      return Response.json(equipment);
    }
    if (String(input).endsWith('/camp')) {
      if (failNext) { failNext = false; slowNext = true; throw new TypeError('读取暂时不可用'); }
      if (slowNext) { slowNext = false; return new Promise<Response>((resolve) => { complete = resolve; }); }
      return Response.json({ ...campFixture, equipment });
    }
    return original(input, init);
  });
  render(<IslandApp />);
  fireEvent.click(await screen.findByRole('button', { name: shopContent.wardrobeTitle }));
  let dialog = await screen.findByRole('dialog', { name: shopContent.wardrobeTitle });
  fireEvent.click(await within(dialog).findByRole('button', { name: /女孩/ }));
  await within(dialog).findByRole('alert');
  fireEvent.click(within(dialog).getByRole('button', { name: content.common.close }));
  fireEvent.click(screen.getByRole('button', { name: shopContent.wardrobeTitle }));
  dialog = await screen.findByRole('dialog', { name: shopContent.wardrobeTitle });
  fireEvent.click(await within(dialog).findByRole('button', { name: /男孩/ }));
  await waitFor(() => expect(within(dialog).getByRole('button', { name: /男孩/ })).toHaveAttribute('aria-pressed', 'true'));
  fireEvent.click(within(dialog).getByRole('button', { name: content.common.close }));
  await act(async () => complete(Response.json({ ...campFixture, equipment: { ...equipment, base_avatar_key: 'avatar-girl-v2' } })));
  expect(document.querySelector('.checkin-sidebar [data-base-avatar]')).toHaveAttribute('data-base-avatar', 'avatar-boy-v2');
});

it('普通页面与管理界面共用全局钱包，营地隐藏，返回后保留余额', async () => {
  installServer(true);
  render(<IslandApp />);
  const wallet = await screen.findByRole('region', { name: shopContent.balance });
  expect(wallet).toHaveClass('global-wallet');
  expect(document.querySelector('.checkin-wallet')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: content.navigation.shop }));
  await screen.findByRole('heading', { name: shopContent.title });
  expect(screen.getByRole('region', { name: shopContent.balance })).toBe(wallet);
  expect(document.querySelector('.shop-wallet')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: shopContent.backpack }));
  await screen.findByRole('heading', { name: shopContent.backpack });
  expect(screen.getByRole('region', { name: shopContent.balance })).toBe(wallet);
  fireEvent.click(screen.getByRole('button', { name: content.navigation.island }));
  await screen.findByRole('heading', { name: islandContent.title });
  expect(document.querySelector('.global-wallet')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: islandContent.back }));
  await screen.findByRole('heading', { name: shopContent.backpack });
  expect(document.querySelectorAll('.global-wallet')).toHaveLength(1);
  await unlock();
  expect(document.querySelectorAll('.global-wallet')).toHaveLength(1);
});
