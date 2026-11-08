import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClient, ApiFailure, errorMessage } from '../../api/client';
import type { Session } from '../../api/types';
import { LoginForm } from '../account/LoginForm';
import { AppearanceDialog } from '../shop/AppearanceDialog';
import { AppearanceProvider, useAppearance } from './AppearanceProvider';
import { CharacterPreview3D } from './CharacterPreview3D';
import { CharacterActionPicker } from './CharacterActionPicker';
import { characterPreviewAnimations, resolveCharacterPreviewAction } from './character-preview-actions';
import type { CharacterLoadStatus } from './character3d-appearance';
import content from './character-verification-content.json';
import '../../styles/island.css';
import './character-verification.css';

// 独立页面沿用真实登录与已保存快照，供全站接入前验证完整外观流程。
function SavedAppearance({ client, accountID, reduced }: { client: ApiClient; accountID: number; reduced: boolean }) {
  const { snapshot, error, refresh, publishSaved } = useAppearance();
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState('idle');
  const [status, setStatus] = useState<CharacterLoadStatus>({ phase: 'loading' });
  if (!snapshot) return <section className="panel"><p role={error ? 'alert' : 'status'}>{error ? errorMessage(error) : content.loadingAppearance}</p>{error ? <button onClick={() => void refresh()}>{content.reload}</button> : null}</section>;
  const character = snapshot.characters.find((item) => item.character_key === snapshot.character_key)!;
  const previewSelection = resolveCharacterPreviewAction(snapshot, action);
  return <>
    <section className="panel character-verification-panel">
      <CharacterPreview3D snapshot={previewSelection.snapshot} action={previewSelection.action} paused={reduced} label={content.preview} onStatus={setStatus} />
      <p data-testid="character-render-status" role="status">{content.status[status.phase]}</p>
      <p data-testid="character-saved-version">{content.version} {snapshot.version}</p>
      <div className="button-row"><CharacterActionPicker characterKey={character.character_key} animations={character.animations} previewAnimations={characterPreviewAnimations(snapshot)} value={previewSelection.action === '_preview' ? action : previewSelection.action} onChange={setAction} /><button onClick={() => setEditing(true)}>{content.edit}</button></div>
    </section>
    {editing && <AppearanceDialog client={client} accountID={accountID} reduceMotion={reduced} onClose={() => setEditing(false)} onSaved={publishSaved} />}
  </>;
}

// 会话到来后才读取外观，认证失败只清除当前页面的会话状态。
function CharacterVerification() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [client] = useState(() => new ApiClient((status) => { if (status === 401) setSession(null); }));
  function acceptSession(next: Session) { client.setCsrfToken(next.csrf_token); client.recordServerTime(next.server_now); setSession(next); }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void client.request<Session>('/session', { signal: controller.signal }).then((next) => { if (!controller.signal.aborted) acceptSession(next); }).catch((reason: unknown) => { if (!controller.signal.aborted && !(reason instanceof ApiFailure && reason.status === 401)) setError(reason); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, attempt]);
  return <main className="character-verification">
    <header><h1>{content.title}</h1><a href="/">{content.back}</a></header><p>{content.description}</p>
    {loading ? <p role="status">{content.loading}</p> : error ? <section className="panel"><p role="alert">{errorMessage(error)}</p><button onClick={() => setAttempt((value) => value + 1)}>{content.reload}</button></section> : !session ? <LoginForm client={client} onLogin={acceptSession} /> : <AppearanceProvider key={session.csrf_token} client={client} active><SavedAppearance client={client} accountID={session.account.id} reduced={session.account.preferences.reduce_motion} /></AppearanceProvider>}
  </main>;
}

document.title = content.title;
createRoot(document.getElementById('root')!).render(<StrictMode><CharacterVerification /></StrictMode>);
