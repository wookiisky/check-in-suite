import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { errorMessage } from '../../api/client';
import type { components } from '../../api/schema';
import { Modal } from '../../components/Modal';
import { uncertainResult } from '../shop/helpers';
import { dispatchFeedback } from '../../feedback/feedback-events';
import content from './title-picker-content.json';
import './title-picker.css';

type Equipment = components['schemas']['Equipment'];
type Purchase = components['schemas']['Purchase'];

// 未知结果由同一客户端保留，临时关闭弹窗不等于撤销服务器写入。
interface PendingTitle {
  purchaseID: string | null; // 唯一待核对的原始目标。
}
const pendingTitles = new WeakMap<Pick<ApiClient, 'request'>, PendingTitle>();

// 称号逐次设置并采用完整保存响应，不参与四槽外观版本和账户版本。
export function TitlePicker({ client, equipment, onClose, onSaved }: {
  client: Pick<ApiClient, 'request'>;
  equipment: Equipment;
  onClose: () => void;
  onSaved: (equipment: Equipment) => void;
}) {
  const [current, setCurrent] = useState(equipment);
  const [items, setItems] = useState<Purchase[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [revision, reload] = useState(0);
  const [readError, setReadError] = useState<unknown>(null);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [failedSave, setFailedSave] = useState<PendingTitle | null>(null);
  const [saved, setSaved] = useState(false);
  const [unknown, setUnknown] = useState(() => pendingTitles.has(client));
  const [checking, setChecking] = useState(false);
  const resultController = useRef<AbortController | null>(null); // 关闭只取消读取，保留未知目标。
  const resultGeneration = useRef(0); // 迟到的核对结果不能改变重开后的事实。
  const checkingRef = useRef(false); // 同一时刻仅发起一次核对。
  const generation = useRef(0); // 读取代次也使卸载前的写响应失效。
  const writingRef = useRef(false); // React 提交前同步阻止重复写入。
  const moreRef = useRef(false); // 同一游标仅发起一次加载。
  const savedCallback = useRef(onSaved); savedCallback.current = onSaved;

  // 通过现有营地读取核对称号，只发布equipment，不重挂营地或重放装备反馈。
  const readResult = useCallback(async () => {
    const command = pendingTitles.get(client);
    if (!command || checkingRef.current) return;
    const controller = new AbortController(); resultController.current = controller;
    const request = ++resultGeneration.current; checkingRef.current = true;
    setChecking(true); setSaveError(null);
    try {
      const result = await client.request<Pick<components['schemas']['CampResponse'], 'equipment'>>('/camp', { signal: controller.signal });
      if (controller.signal.aborted || request !== resultGeneration.current || pendingTitles.get(client) !== command) return;
      pendingTitles.delete(client); setUnknown(false); setCurrent(result.equipment);
      const matched = (result.equipment.title?.id ?? null) === command.purchaseID;
      setFailedSave(matched ? null : command); setSaved(matched);
      savedCallback.current(result.equipment);
    } catch (error) {
      if (!controller.signal.aborted && request === resultGeneration.current) setSaveError(error);
    } finally {
      if (request === resultGeneration.current) { checkingRef.current = false; setChecking(false); }
    }
  }, [client]);

  useEffect(() => { if (!pendingTitles.has(client)) setCurrent(equipment); }, [equipment, client]);
  useEffect(() => {
    if (pendingTitles.has(client)) { setUnknown(true); void readResult(); }
    return () => { resultController.current?.abort(); resultGeneration.current += 1; checkingRef.current = false; };
  }, [client, readResult]);
  useEffect(() => {
    const controller = new AbortController(); const request = ++generation.current;
    setLoading(true); setReadError(null); setMoreError(null); setCursor(null);
    void client.request<components['schemas']['PurchaseList']>('/purchases?status=owned&type=title', { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || generation.current !== request) return;
      setItems(result.items); setCursor(result.next_cursor);
    }).catch((error) => { if (!controller.signal.aborted && generation.current === request) setReadError(error); })
      .finally(() => { if (!controller.signal.aborted && generation.current === request) setLoading(false); });
    return () => { controller.abort(); generation.current += 1; };
  }, [client, revision]);

  // 当前筛选的后续页按订单身份合并，不把迟到页写入已关闭的选择器。
  async function more() {
    if (!cursor || loading || moreRef.current || writingRef.current) return;
    const request = generation.current; moreRef.current = true; setMoreLoading(true); setMoreError(null);
    try {
      const result = await client.request<components['schemas']['PurchaseList']>(`/purchases?status=owned&type=title&cursor=${encodeURIComponent(cursor)}`);
      if (request !== generation.current) return;
      setItems((previous) => [...previous, ...result.items.filter((item) => !previous.some((known) => known.id === item.id))]);
      setCursor(result.next_cursor);
    } catch (error) { if (request === generation.current) setMoreError(error); }
    finally { moreRef.current = false; if (request === generation.current) setMoreLoading(false); }
  }

  // 业务拒绝允许重试；结果未知时先核对事实，禁止用再次PUT充当读取。
  async function save(purchaseID: string | null) {
    if (writingRef.current || loading || pendingTitles.has(client)) return;
    const command: PendingTitle = { purchaseID };
    const request = generation.current; writingRef.current = true; setWriting(true); setSaveError(null); setSaved(false); setFailedSave(null);
    try {
      const result = await client.request<Equipment>('/equipment/title', { method: 'PUT', body: { purchase_id: purchaseID } });
      if (request !== generation.current) return;
      setCurrent(result); setUnknown(false); setSaved(true); savedCallback.current(result); dispatchFeedback('equip');
    } catch (error) {
      const uncertain = uncertainResult(error);
      if (uncertain) pendingTitles.set(client, command);
      if (request !== generation.current) return;
      setSaveError(error); setUnknown(uncertain); setFailedSave(uncertain ? null : command);
    } finally { writingRef.current = false; if (request === generation.current) setWriting(false); }
  }

  // 已佩戴称号可能不在当前订单页；保留它的卸下入口。
  const shown = current.title && !items.some((item) => item.id === current.title?.id) ? [current.title, ...items] : items;

  return <Modal title={content.title} onClose={onClose} closeDisabled={writing}>
    <div className="title-picker" aria-busy={loading || writing || checking}>
      {writing && <p role="status">{content.saving}</p>}
      {unknown && <div role="status"><p>{content.unknown}</p><button className="secondary" disabled={checking || writing} onClick={() => void readResult()}>{checking ? content.checking : content.readResult}</button></div>}
      {saved && <p role="status" className="notice">{content.saved}</p>}
      {readError !== null && <div role="alert"><p>{errorMessage(readError)}</p><button className="secondary" disabled={writing || loading} onClick={() => reload((value) => value + 1)}>{content.retry}</button></div>}
      {(saveError !== null || failedSave) && <div role="alert"><p>{saveError !== null ? errorMessage(saveError) : content.retryKnown}</p>{failedSave && !unknown && <button className="secondary" disabled={writing || loading} onClick={() => void save(failedSave.purchaseID)}>{content.retrySave}</button>}</div>}
      {loading ? <p role="status">{content.loading}</p> : <div className="title-picker-grid">
        {readError === null && shown.length === 0 && !cursor && <p>{content.empty}</p>}
        {shown.map((item) => <article className="title-picker-item panel" key={item.id}>
          <h3>{item.name_snapshot}</h3><img src={`/api/v1/assets/${encodeURIComponent(item.asset_key_snapshot)}`} alt="" />
          <button className={unknown || current.title?.id === item.id ? 'secondary' : undefined} disabled={writing || unknown || checking} aria-label={`${unknown ? content.awaitingResult : current.title?.id === item.id ? content.unequip : content.equip} ${item.name_snapshot}`} aria-pressed={unknown ? undefined : current.title?.id === item.id} onClick={() => void save(current.title?.id === item.id ? null : item.id)}>{unknown ? content.awaitingResult : current.title?.id === item.id ? content.unequip : content.equip}</button>
        </article>)}
      </div>}
      {moreError !== null && <p role="alert">{errorMessage(moreError)}</p>}
      {cursor && <button className="secondary title-picker-more" disabled={loading || moreLoading || writing} onClick={() => void more()}>{moreError !== null ? content.retryMore : moreLoading ? content.loading : content.more}</button>}
    </div>
  </Modal>;
}
