import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IslandApp } from './IslandApp';
import content from './content/zh-CN.json';
import { testSession } from './test/account-fixtures';

// 测试响应按真实账户协议组织，不复用演示账户。
function installServer(loggedIn = false, managementExpiry: string | null = null) {
  let active = loggedIn;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.endsWith('/session')) return active ? Response.json({ ...testSession, management_expires_at: managementExpiry }) : Response.json({ code: 'SESSION_REQUIRED', field_errors: {}, request_id: 'r1' }, { status: 401 });
    if (path.endsWith('/auth/login')) { active = true; return Response.json(testSession); }
    if (path.endsWith('/management/unlock')) return Response.json({ management_expires_at: '2026-10-29T04:30:00Z' });
    if (path.endsWith('/auth/logout')) { active = false; return new Response(null, { status: 204 }); }
    if (path.endsWith('/management/lock')) return new Response(null, { status: 204 });
    if (path.endsWith('/account/profile')) return Response.json({ ...testSession.account, ...JSON.parse(String(init?.body)), version: 2 });
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

afterEach(() => vi.unstubAllGlobals());

describe('账户页面与管理授权', () => {
  it('未登录时填写真实凭据，登录成功后显示账户，退出后清除内容', async () => {
    const server = installServer();
    render(<IslandApp />);
    fireEvent.change(await screen.findByLabelText(content.account.username), { target: { value: 'island-e2e' } });
    fireEvent.change(screen.getByLabelText(content.account.loginPassword), { target: { value: 'Island-Test-2026' } });
    fireEvent.click(screen.getByRole('button', { name: content.account.login }));
    await screen.findByText(testSession.account.display_name);
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
