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
    await screen.findByRole('button', { name: shopContent.wardrobe });
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
    await screen.findByRole('button', { name: shopContent.wardrobe });
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
