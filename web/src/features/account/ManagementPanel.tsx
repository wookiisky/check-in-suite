import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure } from '../../api/client';
import type { ApiClient } from '../../api/client';
import type { Account, Session } from '../../api/types';
import { FieldError, FormFeedback } from '../../components/FormFeedback';
import content from '../../content/zh-CN.json';

// 父页面只需知道是否有草稿或请求，不接触姓名和密码的输入内容。
export interface AccountFormState {
  dirty: boolean; // 有尚未保存的输入。
  pending: boolean; // 正在提交或核对资料。
}

// 账户设置将姓名资料版本与两种密码维护分开，保存姓名不会改动凭据。
export function ManagementPanel({ client, session, onAccount, onPasswordChanged, onFormStateChange }: { client: ApiClient; session: Session; onAccount: (account: Account) => void; onPasswordChanged: () => void; onFormStateChange: (state: AccountFormState) => void }) {
  const [name, setName] = useState(session.account.display_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [latestName, setLatestName] = useState<string | null>(null);
  const [loginState, setLoginState] = useState<AccountFormState>({ dirty: false, pending: false });
  const [managementState, setManagementState] = useState<AccountFormState>({ dirty: false, pending: false });
  const dirty = name !== session.account.display_name || loginState.dirty || managementState.dirty;
  const pending = busy || loginState.pending || managementState.pending;
  useEffect(() => { onFormStateChange({ dirty, pending }); }, [dirty, pending, onFormStateChange]);
  // 刷新和关闭标签页由浏览器确认，敏感输入只保留在当前表单。
  useEffect(() => {
    if (!dirty && !pending) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, pending]);
  async function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (needsRefresh) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const account = await client.request<Account>('/account/profile', { method: 'PATCH', body: { display_name: name.trim(), expected_version: session.account.version } });
      onAccount(account); setName(account.display_name); setSaved(true); setLatestName(null);
    } catch (reason) {
      setError(reason);
      if (reason instanceof ApiFailure && reason.detail.code === 'VERSION_CONFLICT') { setNeedsRefresh(true); setLatestName(null); }
    }
    finally { setBusy(false); }
  }
  // 读取最新资料不覆盖输入；用户看见当前姓名后，下一次明确提交才使用新版本。
  async function reloadProfile() {
    setBusy(true); setError(null);
    try {
      const latest = await client.request<Session>('/session');
      onAccount(latest.account); setLatestName(latest.account.display_name); setNeedsRefresh(false);
    } catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }
  return <div className="settings-stack">
    <section className="panel" aria-labelledby="settings-title">
      <h1 id="settings-title">{content.account.settingsTitle}</h1>
      <p>{content.account.username} <strong>{session.account.username}</strong></p>
      <p className="muted">{content.account.usernameReadonly}</p>
      <form className="form-stack" onSubmit={submitName}>
        <label htmlFor="display-name">{content.account.displayName}</label><input id="display-name" autoComplete="nickname" value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} required aria-describedby="display-name-error" />
        <FieldError error={error} field="display_name" id="display-name-error" /><FormFeedback error={error} />
        {needsRefresh && <div className="notice"><p>{content.account.nameConflictHint}</p><button type="button" disabled={busy} onClick={() => void reloadProfile()}>{content.account.reloadProfile}</button></div>}
        {latestName !== null && <div className="notice"><p>{content.account.currentSavedName} <strong>{latestName}</strong></p><p>{content.account.nameReviewHint}</p></div>}
        {saved && <p role="status">{content.account.nameSaved}</p>}
        <button type="submit" disabled={busy || needsRefresh}>{busy ? content.common.saving : latestName !== null ? content.account.confirmNameDraft : content.account.saveName}</button>
      </form>
    </section>
    <PasswordForm kind="login" client={client} onChanged={onPasswordChanged} onStateChange={setLoginState} />
    <PasswordForm kind="management" client={client} onChanged={onPasswordChanged} onStateChange={setManagementState} />
  </div>;
}

// 密码只在当前表单保留；成功修改后由父页面清除会话和全部管理内容。
function PasswordForm({ kind, client, onChanged, onStateChange }: { kind: 'login' | 'management'; client: ApiClient; onChanged: () => void; onStateChange: (state: AccountFormState) => void }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dirty = Boolean(oldPassword || newPassword || confirmPassword);
  useEffect(() => { onStateChange({ dirty, pending: busy }); }, [dirty, busy, onStateChange]);
  const title = kind === 'login' ? content.account.loginPasswordTitle : content.account.managementPasswordTitle;
  const action = kind === 'login' ? content.account.changeLoginPassword : content.account.changeManagementPassword;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    if (newPassword !== confirmPassword) {
      setError(new ApiFailure(400, { code: 'INVALID_REQUEST', field_errors: { confirm_password: 'PASSWORD_MISMATCH' }, request_id: '' }));
      return;
    }
    setBusy(true);
    try {
      await client.request<void>(`/account/${kind}-password`, { method: 'POST', body: { old_password: oldPassword, new_password: newPassword, confirm_password: confirmPassword } });
      onChanged();
    } catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }
  return <section className="panel" aria-labelledby={`${kind}-title`}>
    <h2 id={`${kind}-title`}>{title}</h2><p className="muted">{content.account.passwordHint}</p>
    <form onSubmit={submit} className="form-stack">
      <label htmlFor={`${kind}-old`}>{content.account.oldPassword}</label><input id={`${kind}-old`} type="password" autoComplete="current-password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} required aria-describedby={`${kind}-old-error`} />
      <FieldError error={error} field="old_password" id={`${kind}-old-error`} />
      <label htmlFor={`${kind}-new`}>{content.account.newPassword}</label><input id={`${kind}-new`} type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required aria-describedby={`${kind}-new-error`} />
      <FieldError error={error} field="new_password" id={`${kind}-new-error`} />
      <label htmlFor={`${kind}-confirm`}>{content.account.confirmPassword}</label><input id={`${kind}-confirm`} type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required aria-describedby={`${kind}-confirm-error`} />
      <FieldError error={error} field="confirm_password" id={`${kind}-confirm-error`} /><FormFeedback error={error} />
      <button type="submit" disabled={busy}>{busy ? content.common.saving : action}</button>
    </form>
  </section>;
}
