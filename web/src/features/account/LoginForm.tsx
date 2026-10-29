import { useState } from 'react';
import type { FormEvent } from 'react';
import type { ApiClient } from '../../api/client';
import type { Session } from '../../api/types';
import { FieldError, FormFeedback } from '../../components/FormFeedback';
import content from '../../content/zh-CN.json';

// 登录只提交用户实际输入，不预填或恢复示例密码。
export function LoginForm({ client, onLogin }: { client: ApiClient; onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(null);
    try { onLogin(await client.request<Session>('/auth/login', { method: 'POST', body: { username, password } })); }
    catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }
  return <section className="panel login-panel" aria-labelledby="login-title">
    <svg className="login-hero" aria-hidden="true" viewBox="0 0 48 48"><path fill="#628643" d="M24 3 7 28h11L9 39h30l-9-11h11z"/><path fill="#865b19" d="M21 37h6v9h-6z"/></svg>
    <h1 id="login-title">{content.account.loginTitle}</h1>
    <form onSubmit={submit} className="form-stack">
      <label htmlFor="login-username">{content.account.username}</label><input id="login-username" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required aria-describedby="username-error" />
      <FieldError error={error} field="username" id="username-error" />
      <label htmlFor="login-password">{content.account.loginPassword}</label><input id="login-password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required aria-describedby="password-error" />
      <FieldError error={error} field="password" id="password-error" /><FormFeedback error={error} />
      <button type="submit" disabled={busy}>{busy ? content.account.loggingIn : content.account.login}</button>
    </form>
  </section>;
}
