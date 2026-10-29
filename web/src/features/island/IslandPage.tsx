import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Modal } from '../../components/Modal';
import { CurrencyAmount } from '../../components/CurrencyAmount';
import type { IslandInsets } from './island-camera';
import { ApiFailure, errorMessage } from '../../api/client';
import type { Camp } from '../shop/types';
import { portraitAssetKey } from '../shop/helpers';
import { useReducedMotion } from '../shop/useReducedMotion';
import { advanceActor, createActor, startActivity } from './island-activity';
import { allowedIslandActivities, useIslandActivityAccess } from './useIslandActivityAccess';
import { canPlace, clampPlacement, interactionPoint } from './island-geometry';
import { TaskIcon } from '../checkin/TaskIcon';
import { IslandScene } from './IslandScene';
import { ItemArtwork } from './IslandArtwork';
import type { IslandActivity, IslandDefinition, IslandPageProps, IslandPlacement, IslandState } from './island-types';
import { dispatchFeedback } from '../../feedback/feedback-events';
import content from './content.json';
import './island-page.css';

// 一件物品的预览共用场景模型，避免商店式小图与岛上形态不一致。
function ItemPreview({ definition, fit = false }: { definition: IslandDefinition; fit?: boolean }) {
  const artwork = useRef<SVGSVGElement>(null);
  const [viewBox, setViewBox] = useState('-95 -150 190 200');
  // 图标按实际素材边界留白，小球等小物品也能看清；库存预览保持原有比例。
  useLayoutEffect(() => {
    if (!fit || !artwork.current?.getBBox) return;
    const bounds = artwork.current.getBBox();
    const padding = Math.max(bounds.width, bounds.height) * 0.12;
    if (padding > 0) setViewBox(`${bounds.x - padding} ${bounds.y - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}`);
  }, [definition.model, fit]);
  return <svg ref={artwork} className="island-item-preview" viewBox={viewBox} aria-hidden="true"><ItemArtwork model={definition.model} houseScale={1} staticMotion /></svg>;
}

// 滚动与边界测量留在活动列表内，不改变角色活动或场景镜头。
function IslandActivityList({ state, reduced, allowed, onActivity }: { state: IslandState; reduced: boolean; allowed: readonly IslandActivity[]; onActivity: (id: string) => void }) {
  const id = useId();
  const section = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ overflow: false, start: true, end: true });

  useLayoutEffect(() => {
    const container = section.current!;
    const viewport = list.current!;
    const items = track.current!;
    // 按全部可用宽度判断是否需要箭头，避免箭头占位导致临界宽度反复切换。
    const measure = () => {
      const next = {
        overflow: items.getBoundingClientRect().width > container.clientWidth + 1,
        start: viewport.scrollLeft <= 1,
        end: viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 1,
      };
      setScroll((current) => current.overflow === next.overflow && current.start === next.start && current.end === next.end ? current : next);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    [container, viewport, items].forEach((element) => observer?.observe(element));
    viewport.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    measure();
    return () => { observer?.disconnect(); viewport.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); };
  }, [state]);

  // 每次移动一个可见列表宽度，系统减少动效时立即定位。
  function browse(direction: number) {
    const viewport = list.current!;
    viewport.scrollBy({ left: direction * viewport.clientWidth, behavior: reduced ? 'instant' : 'smooth' });
  }

  return <section ref={section} className="island-activities" aria-label={content.activitiesTitle}>
    {scroll.overflow && <button className="secondary island-activity-arrow" aria-label={content.previousActivities} title={content.previousActivities} aria-controls={id} disabled={scroll.start} onClick={() => browse(-1)}><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
    <div ref={list} id={id} className="island-activity-buttons"><div ref={track} className="island-activity-track">{state.placements.map((item) => {
      const definition = state.catalog.find((entry) => entry.key === item.item_key);
      if (!definition?.activity) return null;
      const locked = !allowed.includes(definition.activity);
      const label = `${content.activities[definition.activity]} ${definition.name}${locked ? `，${content.activityLocked}` : ''}`;
      return <button key={item.id} className={`secondary ${locked ? 'island-activity-locked' : ''}`} aria-label={label} title={label} onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })} onClick={() => onActivity(item.id)}><ItemPreview definition={definition} fit/>{locked && <svg className="island-lock-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z" fill="var(--island-soft)" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>}</button>;
    })}</div></div>
    {scroll.overflow && <button className="secondary island-activity-arrow" aria-label={content.nextActivities} title={content.nextActivities} aria-controls={id} disabled={scroll.end} onClick={() => browse(1)}><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
  </section>;
}

// 页面管理持久草稿，随机活动只在内存运行，不产生钱包或打卡写入。
export function IslandPage({ client, session, onShop, onBack, onSettings, onCamp }: IslandPageProps) {
  const [state, setState] = useState<IslandState | null>(null);
  const activityAccess = useIslandActivityAccess(client, state);
  const allowed = allowedIslandActivities(activityAccess.access, client.now?.().getTime() ?? Date.now());
  const [lockedActivity, setLockedActivity] = useState<IslandActivity | null>(null);
  const [draft, setDraft] = useState<IslandPlacement[] | null>(null);
  const [camp, setCamp] = useState<Camp | null>(null);
  const [checkinsOpen, setCheckinsOpen] = useState(true);
  const checkins = useRef<HTMLElement>(null);
  const [hudTop, setHudTop] = useState(100);
  const [avatar, setAvatar] = useState('fox-v1');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState({ text: '', success: false });
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [unconfirmedSave, setUnconfirmedSave] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showIndoor, setShowIndoor] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [leaving, setLeaving] = useState<'back' | 'shop' | 'camp' | null>(null);
  const header = useRef<HTMLElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [insets, setInsets] = useState<IslandInsets>({ top: 100, right: 0, bottom: 140, left: 0 });
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const [actor, setActor] = useState(createActor);
  const reduced = useReducedMotion(session.account.preferences.reduce_motion);
  const editing = draft !== null;
  const dirty = Boolean(draft && state && JSON.stringify(draft) !== JSON.stringify(state.placements));
  const placements = draft ?? state?.placements ?? [];
  const latest = useRef({ placements, catalog: state?.catalog ?? [], access: activityAccess.access });
  latest.current = { placements, catalog: state?.catalog ?? [], access: activityAccess.access };

  // 暂停和减少动效时也立即终止已失去资格的活动。
  useEffect(() => {
    setActor((current) => advanceActor(current, 0, latest.current.placements, latest.current.catalog, undefined, allowedIslandActivities(activityAccess.access, client.now?.().getTime() ?? Date.now())));
  }, [activityAccess.access]);

  // 保存提示与普通状态明确区分，阻挡或不可用信息不使用成功动效。
  function showMessage(text: string, success = false) { setMessage({ text, success }); }

  // 只测量浮层占用，列表在内部滚动，不改变场景尺寸。
  useLayoutEffect(() => {
    const measure = () => {
      const top = (header.current?.getBoundingClientRect().bottom || 84) + 12;
      const bottom = dock.current ? Math.max(0, window.innerHeight - dock.current.getBoundingClientRect().top) + 12 : 100;
      const bounds = editing && panelOpen ? panel.current?.getBoundingClientRect() : undefined;
      const sidePanel = window.innerWidth > 1050 || window.innerWidth > 700 && window.innerHeight < 500;
      const tasks = checkins.current?.getBoundingClientRect();
      setHudTop(top);
      const next = { top: window.innerWidth <= 700 && tasks ? Math.max(top, tasks.bottom + 12) : top, left: window.innerWidth > 1050 && tasks ? tasks.right + 12 : 12, right: bounds && sidePanel ? window.innerWidth - bounds.left + 12 : 12, bottom: bounds && !sidePanel ? window.innerHeight - bounds.top + 12 : bottom };
      setInsets((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    [header.current, dock.current, panel.current, checkins.current].forEach((element) => { if (element) observer?.observe(element); });
    window.addEventListener('resize', measure); measure();
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [editing, panelOpen, state, checkinsOpen, camp, hudTop]);

  // 返回、打卡入口和商店共享离开规则，真正写入成功后才执行导航。
  function leave(destination: 'back' | 'shop' | 'camp') {
    if (saving) return;
    if (dirty || unconfirmedSave || conflict) { setLeaving(destination); return; }
    (destination === 'back' ? onBack : destination === 'camp' ? onCamp : onShop)?.();
  }
  function finishLeaving() {
    const destination = leaving;
    setLeaving(null);
    (destination === 'back' ? onBack : destination === 'camp' ? onCamp : onShop)?.();
  }
  async function saveAndLeave() { if (await save()) finishLeaving(); }

  // 角色和小岛同时读取，取消后的响应不覆盖当前页面。
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void Promise.all([client.request<IslandState>('/island', { signal: controller.signal }), client.request<Camp>('/camp', { signal: controller.signal }).then((camp) => {
      // 收到时立即校准，不能等待另一个请求后把时钟倒拨到旧响应时间。
      if (!controller.signal.aborted) client.recordServerTime?.(camp.server_now);
      return camp;
    })]).then(([next, camp]) => {
      if (controller.signal.aborted) return;
      setState(next); setCamp(camp); setAvatar(camp.equipment.avatar ? portraitAssetKey(camp.equipment.avatar) : 'fox-v1');
      setActor(createActor(next.placements, next.catalog)); setConflict(false); setUnconfirmedSave(false);
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, attempt]);

  // 角色帧和物件CSS动画共用可见状态；用户已暂停时也能收到后台切换。
  useEffect(() => {
    const changed = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', changed);
    changed();
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);

  // 后台和编辑时暂停计时，不在恢复后补算离线活动；减少动效仍可主动体验。
  useEffect(() => {
    if (!state || paused || editing || reduced || hidden) return;
    let frame: number | null = null;
    let previous: number | null = null;
    // 与绘制同步；长帧最多推进50毫秒，避免主线程阻塞后角色突然跳远。
    const tick = (timestamp: number) => {
      frame = null;
      if (document.visibilityState === 'hidden') { previous = null; return; }
      if (previous !== null) {
        const seconds = Math.min((timestamp - previous) / 1000, 0.05);
        setActor((current) => advanceActor(current, seconds, latest.current.placements, latest.current.catalog, undefined, allowedIslandActivities(latest.current.access, client.now?.().getTime() ?? Date.now())));
      }
      previous = timestamp;
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [state, paused, editing, reduced, hidden]);

  // 防止浏览器刷新静默丢弃尚未保存的布置。
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [dirty]);

  // 保存失败保持完整草稿，版本冲突不能通过盲目重试覆盖他人的状态。
  async function save() {
    if (!state || !draft || saving || conflict) return false;
    setSaving(true); setError(null); showMessage('');
    try {
      const next = await client.request<IslandState>('/island', { method: 'PUT', body: { expected_version: state.version, placements: draft } });
      setState(next); setDraft(null); setSelected(null); showMessage(content.saved, true); setActor(createActor(next.placements, next.catalog)); setUnconfirmedSave(false);
      dispatchFeedback('island-save'); return true;
    } catch (reason) {
      if (reason instanceof ApiFailure && reason.detail.code === 'VERSION_CONFLICT') setConflict(true);
      else {
        setError(reason);
        if (!(reason instanceof ApiFailure) || reason.status === 0 || reason.status >= 500 || reason.detail.code === 'INVALID_RESPONSE') setUnconfirmedSave(true);
      }
      return false;
    } finally { setSaving(false); }
  }
  // 退出编辑还原服务器布局，冲突时重新读取已确认的新版本。
  function cancel() {
    setDraft(null); setSelected(null); setError(null); showMessage(''); setShowIndoor(false); setPanelOpen(true);
    if (conflict || unconfirmedSave) { setConflict(false); setUnconfirmedSave(false); setState(null); setAttempt((value) => value + 1); }
  }
  // 同一实例只在草稿中替换，不创建额外所有权。
  function move(next: IslandPlacement) {
    setDraft((current) => current?.map((item) => item.id === next.id ? next : item) ?? current);
    showMessage('');
  }
  // 自动寻找第一个可用位置；房屋和环境替换当前同类，不复制出第二份。
  function place(id: string) {
    if (!state || !draft) return;
    const owned = state.inventory.find((item) => item.id === id);
    const definition = state.catalog.find((item) => item.key === owned?.item_key);
    if (!owned || !definition || draft.some((item) => item.id === id)) return;
    const single = definition.category === 'house' || definition.category === 'environment';
    const replacing = draft.find((item) => state.catalog.find((entry) => entry.key === item.item_key)?.category === definition.category);
    const remaining = single ? draft.filter((item) => state.catalog.find((entry) => entry.key === item.item_key)?.category !== definition.category) : draft;
    const zone = definition.category === 'house' || definition.category === 'environment' || definition.category === 'creature' || definition.model === 'run' ? 'outdoor' : showIndoor ? 'indoor' : 'outdoor';
    const base: IslandPlacement = { ...owned, x: single ? replacing?.x ?? 0 : 0, y: single ? replacing?.y ?? 0 : 0, rotation: 0, zone };
    const candidates = [base];
    const limit = zone === 'indoor' ? 2 : 7;
    for (let y = -limit; y <= limit; y += 1) for (let x = -limit; x <= limit; x += 1) candidates.push({ ...base, x, y });
    // 新增室外物品优先放在房门前的近处，避免放大屋顶挡住首次拖拽；空地不足再尝试全岛。
    const house = remaining.find((item) => state.catalog.find((entry) => entry.key === item.item_key)?.category === 'house');
    const houseDefinition = state.catalog.find((item) => item.key === house?.item_key);
    if (!single && zone === 'outdoor' && house && houseDefinition) {
      const front = interactionPoint(house, houseDefinition).y;
      candidates.sort((a, b) => Number(a.y < front) - Number(b.y < front) || Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
    }
    const candidate = candidates.map((item) => clampPlacement(item, definition)).find((item) => canPlace(item, remaining, state.catalog));
    if (!candidate) { showMessage(content.blockedPlacement); return; }
    setDraft([...remaining, candidate]); setSelected(id); showMessage('');
  }
  // 主动互动与自主活动共享执行路径；减少动效时直接展示活动静态状态。
  function interact(id: string) {
    if (!state || editing) return;
    const definition = state.catalog.find((entry) => entry.key === state.placements.find((item) => item.id === id)?.item_key);
    const currentAllowed = allowedIslandActivities(activityAccess.access, client.now?.().getTime() ?? Date.now());
    if (definition?.activity && !currentAllowed.includes(definition.activity)) { setLockedActivity(definition.activity); showMessage(''); return; }
    setLockedActivity(null);
    const next = startActivity(actor, id, state.placements, state.catalog, currentAllowed);
    if (!next) { showMessage(content.activityUnavailable); return; }
    if (reduced) {
      const point = next.route.at(-1);
      setActor({ ...next, ...(point ?? {}), phase: 'acting', action: next.destination, route: [] });
    } else setActor(next);
    setPaused(false); showMessage('');
  }
  const selectedPlacement = placements.find((item) => item.id === selected);
  const selectedDefinition = state?.catalog.find((item) => item.key === selectedPlacement?.item_key);
  // 键盘及按钮微调共用同一占地和通道规则。
  function adjust(dx: number, dy: number) {
    if (!selectedPlacement || !selectedDefinition || !state) return;
    const next = clampPlacement({ ...selectedPlacement, x: selectedPlacement.x + dx, y: selectedPlacement.y + dy }, selectedDefinition);
    if (canPlace(next, placements, state.catalog)) move(next); else showMessage(content.blockedPlacement);
  }
  // 物品移入房屋后使用室内局部坐标，避免保存室外的大坐标。
  function changeZone() {
    if (!selectedPlacement || !selectedDefinition || !state) return;
    const zone = selectedPlacement.zone === 'indoor' ? 'outdoor' : 'indoor';
    const next = clampPlacement({ ...selectedPlacement, zone, x: 0, y: zone === 'indoor' ? 0 : 3 }, selectedDefinition);
    if (canPlace(next, placements, state.catalog)) { move(next); setShowIndoor(zone === 'indoor'); } else showMessage(content.blockedPlacement);
  }
  return <div className="island-page island-fullscreen" style={{ '--island-hud-top': `${hudTop}px` } as CSSProperties}>
    <header ref={header} className="island-page-header"><div className="island-heading"><button className="secondary" disabled={saving} onClick={(event) => { event.currentTarget.focus(); leave('back'); }}>{content.back}</button><h1>{content.title}</h1></div>
      {camp && <section className="island-wallet" aria-label={content.balance}><CurrencyAmount currency="coins" amount={camp.wallet.coins}><strong>{camp.wallet.coins}</strong></CurrencyAmount><CurrencyAmount currency="diamonds" amount={camp.wallet.diamonds}><strong>{camp.wallet.diamonds}</strong></CurrencyAmount></section>}
      <div className="island-actions">{state && <button disabled={editing || saving} aria-pressed={editing} onClick={() => { setDraft(state.placements.map((item) => ({ ...item }))); setCheckinsOpen(false); setPanelOpen(true); setError(null); showMessage(''); }}>{content.edit}</button>}{onShop && <button className="secondary" disabled={saving} onClick={(event) => { event.currentTarget.focus(); leave('shop'); }}>{content.shop}</button>}{onSettings && <button className="secondary" disabled={saving} onClick={(event) => { event.currentTarget.focus(); onSettings(); }}>{content.settings}</button>}</div>
    </header>
    {camp && onCamp && <aside ref={checkins} className={`island-checkin-panel ${checkinsOpen ? 'is-expanded' : 'is-collapsed'}`} aria-label={content.checkinTitle}>
      <button className="secondary island-checkin-toggle" aria-label={checkinsOpen ? content.collapseCheckins : content.expandCheckins} aria-expanded={checkinsOpen} aria-controls="island-checkin-list" onClick={() => setCheckinsOpen((value) => !value)}><svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path d="M9 5h11M9 12h11M9 19h11M2 5l1 1 3-3M2 12l1 1 3-3M2 19l1 1 3-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg><svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" style={{ transform: checkinsOpen ? 'rotate(180deg)' : undefined }}><path d="m3 6 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      {checkinsOpen && <div id="island-checkin-list" className="island-checkin-list">{camp.tasks.map((task) => <button key={task.id} className="secondary" aria-label={task.name} title={task.name} disabled={saving} onClick={(event) => { event.currentTarget.focus(); leave('camp'); }}><TaskIcon name={task.icon_key}/></button>)}{camp.tasks.length === 0 && <p className="island-sr-only">{camp.has_scheduled_tasks ? content.checkinEmpty : content.checkinNoTasks}</p>}</div>}
    </aside>}
    {loading && <p role="status">{content.loading}</p>}
    {error !== null && !leaving && <div className="island-notice island-error" role="alert"><p>{errorMessage(error)}</p>{!editing && <button onClick={() => setAttempt((value) => value + 1)}>{content.retry}</button>}</div>}
    {(activityAccess.error !== null || (lockedActivity && !allowed.includes(lockedActivity))) && <section className="island-notice island-access-notice" aria-label={content.activityLocked}>
      {activityAccess.error !== null && <><p role="alert">{content.accessRefreshFailed}</p><button disabled={activityAccess.pending} onClick={activityAccess.refresh}>{content.retryAccess}</button></>}
      {lockedActivity && !allowed.includes(lockedActivity) && <><p role="status">{activityAccess.pending ? content.accessPending : content.activityUnlockHint}</p>
        <ul>{activityAccess.access?.activity_access.find((entry) => entry.activity === lockedActivity)?.tasks.map((task) => <li key={task.id}>{task.name}{!task.enabled && <span> · {content.inactiveTask}</span>}</li>)}</ul>
        <div className="button-row">{onCamp && <button disabled={saving} onClick={() => leave('camp')}>{content.goCheckin}</button>}<button className="secondary" onClick={() => setLockedActivity(null)}>{content.dismiss}</button></div>
      </>}
    </section>}
    {message.text && <p className={`island-notice ${message.success ? 'feedback-success' : ''}`} role="status">{message.text}</p>}
    {conflict && <div className="island-notice island-error" role="alert"><p>{content.conflict}</p><button onClick={cancel}>{content.reloadAfterCancel}</button></div>}
    {state && <>
      {editing && <div ref={dock} className="island-edit-bar"><button disabled={saving || conflict} onClick={() => void save()}>{saving ? content.saving : content.save}</button><button className="secondary" disabled={saving} onClick={cancel}>{content.cancel}</button><button className="secondary" aria-pressed={showIndoor} disabled={saving} onClick={() => setShowIndoor((value) => !value)}>{showIndoor ? content.showOutdoor : content.showIndoor}</button><button className="secondary" aria-expanded={panelOpen} aria-controls="island-inventory-panel" onClick={() => setPanelOpen((value) => !value)}>{panelOpen ? content.closeInventory : content.openInventory}</button></div>}
      <div className={`island-workspace ${editing ? 'island-is-editing' : ''}`} aria-busy={saving}>
        <div className="island-main-scene" inert={saving}>
          <IslandScene insets={insets} placements={placements} catalog={state.catalog} actor={actor} avatar={avatar} editing={editing} indoor={showIndoor} selected={selected} staticMotion={reduced || editing} motionPaused={paused || hidden} onSelect={setSelected} onMove={move} onActivity={interact} onBlocked={() => showMessage(content.blockedPlacement)} />

        </div>
        {editing && panelOpen && <aside ref={panel} id="island-inventory-panel" className="island-editor island-editor-shell" inert={saving} aria-label={content.inventory}>
          <div className="island-editor-heading"><h2>{content.inventory}</h2></div><div className="island-editor-scroll">
          <div className="island-selection">
            {selectedPlacement && selectedDefinition ? <>
              <strong>{selectedDefinition.name}</strong>
              <p>{selectedPlacement.zone === 'indoor' ? content.indoor : content.outdoor}</p>
              {!selectedDefinition.activity && <p className="island-hint">{content.staticItem}</p>}
              {selectedDefinition.movable ? <><div className="island-move-buttons"><button className="secondary" aria-label={content.moveLeft} onClick={() => adjust(-0.25, 0)}>←</button><button className="secondary" aria-label={content.moveUp} onClick={() => adjust(0, -0.25)}>↑</button><button className="secondary" aria-label={content.moveDown} onClick={() => adjust(0, 0.25)}>↓</button><button className="secondary" aria-label={content.moveRight} onClick={() => adjust(0.25, 0)}>→</button></div>
                {selectedDefinition.category === 'decoration' || selectedDefinition.category === 'creature' ? <button className="secondary" onClick={() => { const next = { ...selectedPlacement, rotation: selectedPlacement.rotation === 0 ? 180 as const : 0 as const }; if (canPlace(next, placements, state.catalog)) move(next); else showMessage(content.blockedPlacement); }}>{content.rotate}</button> : null}
                {selectedDefinition.category !== 'house' && selectedDefinition.category !== 'creature' && selectedDefinition.model !== 'run' && <button className="secondary" onClick={changeZone}>{selectedPlacement.zone === 'indoor' ? content.moveOutside : content.moveInside}</button>}
              </> : <p className="island-hint">{content.fixedItem}</p>}
              {selectedDefinition.category === 'house' || selectedDefinition.category === 'environment' ? <p className="island-hint">{content.requiredPlacement}</p> : <button className="secondary" onClick={() => { setDraft(placements.filter((item) => item.id !== selectedPlacement.id)); setSelected(null); }}>{content.store}</button>}
            </> : <p>{content.nothingSelected}</p>}
          </div>
          <h3>{content.stored}</h3>
          <div className="island-inventory-list">{state.inventory.filter((item) => !placements.some((placed) => placed.id === item.id)).map((item) => {
            const definition = state.catalog.find((entry) => entry.key === item.item_key);
            return definition && <div className="island-inventory-item" key={item.id} data-inventory-id={item.id}><ItemPreview definition={definition} /><div><strong>{definition.name}</strong><span>{content.categories[definition.category]}</span></div><button className="secondary" aria-label={`${content.place} ${definition.name}`} onClick={() => place(item.id)}>{content.place}</button></div>;
          })}{state.inventory.every((item) => placements.some((placed) => placed.id === item.id)) && <p className="island-hint">{content.emptyInventory}</p>}</div>
          <h3>{content.placed}</h3>
          <div className="island-placed-list">{placements.map((item) => <button key={item.id} className="secondary" aria-pressed={item.id === selected} onClick={() => { setSelected(item.id); setShowIndoor(item.zone === 'indoor'); }}>{state.catalog.find((entry) => entry.key === item.item_key)?.name}</button>)}</div>
        </div></aside>}
      </div>
      {!editing && <div ref={dock} className="island-game-dock">
        <div className="island-character-status"><span className="island-status-dot"/><span aria-live="polite">{paused ? content.paused : content.actorStatus[actor.action]}</span><button className="secondary" onClick={() => setPaused((value) => !value)}>{paused ? content.resume : content.pause}</button></div>
        <IslandActivityList state={state} reduced={reduced} allowed={allowed} onActivity={interact}/>
      </div>}

    </>}
    {leaving && <Modal title={content.leaveTitle} onClose={() => setLeaving(null)} closeDisabled={saving}><p>{content.leaveHint}</p>{error !== null && <p role="alert" className="form-error">{errorMessage(error)}</p>}{conflict && <p role="alert">{content.conflict}</p>}<div className="button-row"><button disabled={saving || conflict} onClick={() => void saveAndLeave()}>{saving ? content.saving : content.saveAndLeave}</button><button className="secondary" disabled={saving} onClick={finishLeaving}>{content.discardAndLeave}</button><button className="secondary" disabled={saving} onClick={() => setLeaving(null)}>{content.keepEditing}</button></div></Modal>}
  </div>;
}
