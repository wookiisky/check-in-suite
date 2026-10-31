import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { dispatchFeedback } from '../../feedback/feedback-events';
import { AccessoryEditor } from './AccessoryEditor';
import { BaseAvatarPicker } from './BaseAvatarPicker';
import { CharacterPanel } from './CharacterPanel';
import { Wardrobe } from './Wardrobe';
import { categoryLabel, categoryPurchaseType, itemCategory, wardrobeCategories } from './shop-categories';
import { portraitType, shopError } from './helpers';
import type { Camp, Equipment, Purchase, PurchaseList, ShopProps } from './types';
import content from './content.json';
import './shop.css';

// 形象编辑独立于商店，只有服务端确认的新装备才同步回入口页面。
export function WardrobeDialog({ client, session, onClose, onEquipmentSaved }: ShopProps & {
  onClose: (refreshEquipment?: boolean) => void;
  onEquipmentSaved?: (equipment: Equipment) => void;
}) {
  const [type, setType] = useState('');
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [snapshot, setSnapshot] = useState<Camp | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [revision, refresh] = useState(0);
  const [editingOutfit, setEditingOutfit] = useState(false);
  const [highlightCharacter, setHighlightCharacter] = useState(false);
  const generation = useRef(0);
  const awaitingEquipment = useRef(false); // 写成功后读取失败，只重读装备，不再次写入。
  const savedCallback = useRef(onEquipmentSaved);
  savedCallback.current = onEquipmentSaved;
  const query = new URLSearchParams({ status: 'owned', ...(type ? { type: categoryPurchaseType(type) } : {}) }).toString();

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoading(true);
    setLoadingMore(false);
    setPurchases([]);
    setCursor(null);
    setError(null);
    void (async () => {
      try {
        const [camp, result] = await Promise.all([
          client.request<Camp>('/camp', { signal: controller.signal }),
          client.request<PurchaseList>(`/purchases?${query}`, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted || generation.current !== current) return;
        setSnapshot(camp);
        setPurchases(result.items);
        setCursor(result.next_cursor);
        if (awaitingEquipment.current) {
          awaitingEquipment.current = false;
          setHighlightCharacter(true);
        }
        savedCallback.current?.(camp.equipment);
      } catch (reason) {
        if (!controller.signal.aborted && generation.current === current) setError(reason);
      } finally {
        if (!controller.signal.aborted && generation.current === current) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [client, query, revision]);

  // 同一筛选的后续订单可以追加，旧分类的迟到响应不能混入当前列表。
  async function more() {
    if (!cursor || loading || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await client.request<PurchaseList>(`/purchases?${query}&cursor=${encodeURIComponent(cursor)}`);
      if (generation.current !== current) return;
      setPurchases((items) => [...items, ...result.items.filter((item) => !items.some((known) => known.id === item.id))]);
      setCursor(result.next_cursor);
    } catch (reason) {
      if (generation.current === current) setError(reason);
    } finally {
      if (generation.current === current) setLoadingMore(false);
    }
  }

  // 装备与基础形象共用提交边界，成功反馈只属于写入，不属于随后读取。
  async function saveEquipment(path: string, options: { method: 'PUT' | 'DELETE'; body?: { purchase_id: string | null } | { asset_key: string } }) {
    setWriting(true);
    setError(null);
    setMessage('');
    setHighlightCharacter(false);
    try {
      await client.request(path, options);
      setMessage(content.equipmentSaved);
      dispatchFeedback('equip');
      awaitingEquipment.current = true;
      const camp = await client.request<Camp>('/camp');
      setSnapshot(camp);
      awaitingEquipment.current = false;
      setHighlightCharacter(true);
      savedCallback.current?.(camp.equipment);
    } catch (reason) {
      setError(reason);
    } finally {
      setWriting(false);
    }
  }

  // 固定部位、自由饰品与单槽装备分别沿用原有接口，不互相覆盖。
  function toggle(item: Purchase, equip: boolean) {
    const kind = portraitType(item);
    if (!kind) return;
    if (item.wearable_slot) {
      void saveEquipment(`/equipment/${item.wearable_slot}`, { method: 'PUT', body: { purchase_id: equip ? item.id : null } });
    } else if (kind === 'accessory' || kind === 'effect') {
      void saveEquipment(`/equipment/${kind === 'effect' ? 'effects' : 'accessories'}/${item.id}`, { method: equip ? 'PUT' : 'DELETE' });
    } else {
      void saveEquipment(`/equipment/${kind}`, { method: 'PUT', body: { purchase_id: equip ? item.id : null } });
    }
  }

  const items = purchases.filter((item) => portraitType(item) !== null && (!type || itemCategory(item, true) === type));
  const busy = writing || loading || loadingMore || awaitingEquipment.current;
  return <Modal title={content.wardrobeTitle} onClose={() => onClose(awaitingEquipment.current)} closeDisabled={writing || editingOutfit}>
    <div className="shop-workspace shop-wardrobe-dialog">
      {message && <p role="status" className="shop-warning feedback-success">{message}</p>}
      {error !== null && <div role="alert"><p className="shop-error">{shopError(error)}</p><button type="button" className="secondary" disabled={writing} onClick={() => refresh((value) => value + 1)}>{content.reload}</button></div>}
      <label className="shop-type-filter">{content.typeFilter}
        <select aria-label={content.typeFilter} value={type} disabled={writing} onChange={(event) => { generation.current += 1; setType(event.target.value); setMessage(''); }}>
          <option value="">{content.allTypes}</option>
          {wardrobeCategories.map((category) => <option value={category} key={category}>{categoryLabel(category)}</option>)}
        </select>
      </label>
      {loading && <p role="status">{content.loading}</p>}
      {snapshot && <div className="shop-wardrobe-layout">
        <section>
          <BaseAvatarPicker equipment={snapshot.equipment} busy={busy} onSelect={(key) => void saveEquipment('/equipment/base-avatar', { method: 'PUT', body: { asset_key: key } })} />
          <Wardrobe items={items} hasMore={Boolean(cursor)} equipment={snapshot.equipment} busy={busy} onToggle={toggle} />
          {cursor && <div className="shop-stack"><button type="button" className="secondary" disabled={busy} onClick={() => void more()}>{content.more}</button></div>}
        </section>
        <aside className="panel">
          <div className={highlightCharacter ? 'feedback-pop' : undefined} onAnimationEnd={(event) => { if (event.target === event.currentTarget) setHighlightCharacter(false); }}>
            <CharacterPanel equipment={snapshot.equipment} displayName={session.account.display_name} reduceMotion={session.account.preferences.reduce_motion} />
          </div>
          <button type="button" className="secondary shop-edit-outfit" disabled={busy || snapshot.equipment.accessories.length === 0} onClick={(event) => { event.currentTarget.focus(); setEditingOutfit(true); }}>{content.editOutfit}</button>
        </aside>
      </div>}
      {editingOutfit && snapshot && <AccessoryEditor equipment={snapshot.equipment} displayName={session.account.display_name} reduceMotion={session.account.preferences.reduce_motion} client={client}
        onClose={() => setEditingOutfit(false)} onSaved={(next) => {
          awaitingEquipment.current = false;
          setSnapshot((current) => current ? { ...current, equipment: next } : current);
          savedCallback.current?.(next);
        }} />}
    </div>
  </Modal>;
}
