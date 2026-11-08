import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '../../api/types';
import { FormFeedback } from '../../components/FormFeedback';
import type { GroupClient, GroupState } from './group-types';
import content from './content.json';
import './groups.css';

/** 成员选择只改变只读查询目标，切换时重建内容以取消旧请求并清除旧结果。 */
export function GroupBrowse({ client, session, children }: { client: GroupClient; session: Session; children: (accountID: number, onAccessDenied: () => void) => ReactNode }) {
  const [state, setState] = useState<GroupState | null>(null);
  const [selected, setSelected] = useState(session.account.id);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [accessChanged, setAccessChanged] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    client.request<GroupState>('/groups', { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        setState(value);
        setSelected((current) => current === session.account.id || value.members.some((member) => member.id === current) ? current : session.account.id);
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason); });
    return () => controller.abort();
  }, [client, session.account.id, attempt]);
  const accessDenied = useCallback(() => { setSelected(session.account.id); setAccessChanged(true); setAttempt((value) => value + 1); }, [session.account.id]);
  return <>
    <div className="group-browse">
      {state?.current_group ? <><strong>{state.current_group.name}</strong><label>{content.memberLabel}<select value={selected} onChange={(event) => { setSelected(Number(event.target.value)); setAccessChanged(false); }}>
        <option value={session.account.id}>{content.myself}</option>{state.members.filter((member) => member.id !== session.account.id).map((member) => <option key={member.id} value={member.id}>{member.display_name}</option>)}
      </select></label></> : null}
      <FormFeedback error={error} />{error !== null && <button className="secondary" onClick={() => setAttempt((value) => value + 1)}>{content.retry}</button>}
      {accessChanged && <p role="status">{content.accessChanged}</p>}
    </div>
    <div key={selected}>{children(selected, accessDenied)}</div>
  </>;
}
