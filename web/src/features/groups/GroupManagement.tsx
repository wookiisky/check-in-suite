import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { FormFeedback } from '../../components/FormFeedback';
import type { AccountFormState } from '../account/ManagementPanel';
import type { GroupClient, GroupState } from './group-types';
import content from './content.json';

/** 加入与退出只使用当次输入的管理密码，成功后立即清除敏感输入。 */
export function GroupManagement({ client, onFormStateChange }: { client: GroupClient; onFormStateChange?: (state: AccountFormState) => void }) {
  const [state, setState] = useState<GroupState | null>(null);
  const [groupID, setGroupID] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    client.request<GroupState>('/groups', { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setState(value); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, attempt]);
  useEffect(() => { onFormStateChange?.({ dirty: password !== '' || groupID !== '', pending: busy }); }, [password, groupID, busy, onFormStateChange]);

  // 提交失败保留选择与密码，用户可以修正后重试。
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!state || busy) return;
    const leaving = state.current_group !== null;
    setBusy(true); setError(null); setNotice('');
    try {
      const result = await client.request<GroupState>(leaving ? '/groups/leave' : '/groups/join', { method: 'POST', body: leaving ? { password } : { group_id: Number(groupID), password } });
      setState(result); setPassword(''); setGroupID(''); setNotice(leaving ? content.left : content.joined);
    } catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }
  return <section className="panel" aria-labelledby="group-management-heading">
    <h2 id="group-management-heading">{content.title}</h2>
    {loading && <p role="status">{content.loading}</p>}
    <FormFeedback error={error} />
    {error !== null && <button type="button" className="secondary" onClick={() => setAttempt((value) => value + 1)}>{content.retry}</button>}
    {notice && <p role="status">{notice}</p>}
    {state && <form className="form-stack" onSubmit={submit}>
      {state.current_group ? <p>{content.currentGroup}：<strong>{state.current_group.name}</strong></p> : <>
        <label htmlFor="join-group">{content.existingGroups}</label>
        <select id="join-group" value={groupID} disabled={busy} onChange={(event) => setGroupID(event.target.value)} required><option value="">{content.chooseGroup}</option>{state.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
        {state.groups.length === 0 && <p>{content.noGroups}</p>}
      </>}
      <label htmlFor="group-management-password">{content.managementPassword}</label>
      <input id="group-management-password" type="password" autoComplete="off" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} required />
      <button type="submit" disabled={busy || !password || (!state.current_group && !groupID)}>{busy ? content.saving : state.current_group ? content.leave : content.join}</button>
    </form>}
  </section>;
}
