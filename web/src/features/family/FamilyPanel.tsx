import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure } from '../../api/client';
import type { ApiClient } from '../../api/client';
import type { Session } from '../../api/types';
import type { components } from '../../api/schema';
import { FormFeedback } from '../../components/FormFeedback';
import { Modal } from '../../components/Modal';
import { createIdempotencyKey } from '../../api/idempotency-key';
import content from './content.json';
import './family.css';

type Client = Pick<ApiClient, 'request'>;
type Message = components['schemas']['Message'];
type MessageList = components['schemas']['MessageList'];

// 未确认的命令独立于可编辑草稿，页面离开不代表服务端取消。
interface PendingMessage {
  key: string; // 原提交幂等键。
  text: string; // 原提交文字，恢复时不可替换。
}
const pendingMessages = new WeakMap<Client, PendingMessage>();
// 草稿与原提交分别保存，迟到成功只清命令，不删除后来输入。
const messageDrafts = new WeakMap<Client, string>();

// 只有明确的业务拒绝才能放弃原命令；授权丢失后仍需恢复核对。
function definiteFailure(error: unknown): boolean {
  return error instanceof ApiFailure && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403 && error.detail.code !== 'INVALID_RESPONSE';
}

// 留言列表和输入分别保存，读取重试不重复发布或清空草稿。
export function FamilyPanel({ client, session }: { client: Client; session: Session }) {
  const [text, setText] = useState(() => messageDrafts.get(client) ?? pendingMessages.get(client)?.text ?? '');
  const [pending, setPending] = useState<PendingMessage | null>(() => pendingMessages.get(client) ?? null);
  const [items, setItems] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);
  const [writeError, setWriteError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [removeTarget, setRemoveTarget] = useState<Message | null>(null);
  const readController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const textRef = useRef(text);
  textRef.current = text;

  // 后来的列表读取取消前一次，追加分页只合并未见过的记录。
  async function load(next: string | null = null) {
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    setLoading(true); setReadError(null);
    try {
      const result = await client.request<MessageList>(`/messages${next ? `?cursor=${encodeURIComponent(next)}` : ''}`, { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      setItems((old) => next ? [...old, ...result.items.filter((item) => !old.some((existing) => existing.id === item.id))] : result.items);
      setCursor(result.next_cursor);
    } catch (error) { if (!controller.signal.aborted && mounted.current) setReadError(error); }
    finally { if (!controller.signal.aborted && mounted.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true; void load();
    return () => { mounted.current = false; readController.current?.abort(); };
  }, [client]);

  // 先核对原命令；成功后保留不同于原提交的后来输入。
  async function submit(event: FormEvent) {
    event.preventDefault();
    const command = pending ?? { key: createIdempotencyKey(), text: text.trim() };
    if (!command.text || [...command.text].length > session.limits.message_max) return;
    pendingMessages.set(client, command); setPending(command); setBusy(true); setWriteError(null); setNotice('');
    try {
      await client.request<Message>('/messages', { method: 'POST', body: { text: command.text }, idempotencyKey: command.key });
      pendingMessages.delete(client);
      if (messageDrafts.get(client)?.trim() === command.text) messageDrafts.delete(client);
      if (!mounted.current) return;
      setPending(null); if (textRef.current.trim() === command.text) setText('');
      setNotice(content.published); void load();
    } catch (error) {
      if (definiteFailure(error)) { pendingMessages.delete(client); if (mounted.current) setPending(null); }
      if (mounted.current) setWriteError(error);
    } finally { if (mounted.current) setBusy(false); }
  }
  async function remove() {
    if (!removeTarget) return;
    setBusy(true); setWriteError(null);
    try {
      await client.request<void>(`/messages/${encodeURIComponent(removeTarget.id)}`, { method: 'DELETE' });
      if (!mounted.current) return;
      setItems((old) => old.filter((item) => item.id !== removeTarget.id)); setRemoveTarget(null); setNotice(content.deleted); void load();
    } catch (error) { if (mounted.current) setWriteError(error); }
    finally { if (mounted.current) setBusy(false); }
  }
  const tooLong = [...text.trim()].length > session.limits.message_max;
  return <section className="panel family-panel">
    <h2>{content.title}</h2>
    <form className="family-form" onSubmit={(event) => void submit(event)}><label htmlFor="family-message">{content.input}</label><textarea id="family-message" value={text} rows={3} onChange={(event) => { setText(event.target.value); messageDrafts.set(client, event.target.value); }} />
      {tooLong && !pending && <p role="alert" className="form-error">{content.tooLong}</p>}
      <FormFeedback error={writeError} />
      {pending && !busy && <p role="status">{content.unknown}</p>}
      <button disabled={busy || (!pending && (!text.trim() || tooLong))}>{busy ? content.publishing : pending ? content.resolve : content.publish}</button>
    </form>
    {notice && <p role="status">{notice}</p>}
    <FormFeedback error={readError} />{readError !== null && <button className="secondary" onClick={() => void load()}>{content.reload}</button>}
    {!loading && !readError && items.length === 0 && <p className="muted">{content.empty}</p>}
    <ul className="family-messages">{items.map((item) => <li key={item.id}><p>{item.text}</p><time dateTime={item.created_at}>{new Intl.DateTimeFormat('zh-CN', { timeZone: session.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.created_at))}</time><button className="secondary" disabled={busy} onClick={(event) => { event.currentTarget.focus(); setRemoveTarget(item); setWriteError(null); }}>{content.remove}</button></li>)}</ul>
    {loading && <p role="status">{content.loading}</p>}{cursor && <><p className="muted">{content.incomplete}</p><button className="secondary" disabled={loading} onClick={() => void load(cursor)}>{content.loadMore}</button></>}
    {removeTarget && <Modal title={content.remove} onClose={() => setRemoveTarget(null)} closeDisabled={busy}><div className="family-form"><p>{content.removeWarning}</p><p className="family-message-text">{removeTarget.text}</p><FormFeedback error={writeError} /><div className="button-row"><button disabled={busy} onClick={() => void remove()}>{content.confirmRemove}</button><button className="secondary" disabled={busy} onClick={() => setRemoveTarget(null)}>{content.cancel}</button></div></div></Modal>}
  </section>;
}
