import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WardrobeDialog } from './WardrobeDialog';
import { camp, equipment, outfit, purchase } from './test-fixtures';
import { testSession } from '../../test/account-fixtures';
import type { Equipment, Purchase } from './types';
import type { Session } from '../../api/types';
import { FEEDBACK_EVENT } from '../../feedback/feedback-events';
import content from './content.json';

const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

describe('形象装扮弹窗', () => {
  it('装备后读取完整角色并通知首页，保存时不能关闭', async () => {
    let complete: (() => void) | undefined;
    let current = equipment;
    const saved = vi.fn();
    const close = vi.fn();
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return { ...camp, equipment: current };
      if (path.startsWith('/purchases?')) return { items: [purchase], next_cursor: null };
      if (path === `/equipment/accessories/${purchase.id}`) {
        await new Promise<void>((resolve) => { complete = resolve; });
        current = { ...equipment, accessories: [purchase], accessory_layouts: outfit.accessory_layouts };
        return {};
      }
      throw new Error(path);
    });
    render(<WardrobeDialog client={{ request }} session={session} onClose={close} onEquipmentSaved={saved} />);
    fireEvent.click(await screen.findByRole('button', { name: `${content.equip} ${purchase.name_snapshot}` }));
    expect(screen.getByRole('button', { name: content.close })).toBeDisabled();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }));
    expect(close).not.toHaveBeenCalled();
    await act(async () => { complete!(); });
    await waitFor(() => expect(saved).toHaveBeenCalledWith(current));
    expect(screen.getByRole('button', { name: `${content.unequip} ${purchase.name_snapshot}` })).toBeEnabled();
    expect(screen.getByRole('button', { name: content.close })).toBeEnabled();
    expect(request.mock.calls.filter(([path]) => String(path).startsWith('/equipment'))).toHaveLength(1);
  });

  it('装备成功后的读取失败只重读，不重放写入与反馈', async () => {
    let changed = false;
    let failRead = true;
    const saved = vi.fn();
    const close = vi.fn();
    const feedback = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, feedback);
    const current: Equipment = { ...equipment, accessories: [purchase], accessory_layouts: outfit.accessory_layouts };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') {
        if (changed && failRead) throw new Error('offline');
        return { ...camp, equipment: changed ? current : equipment };
      }
      if (path.startsWith('/purchases?')) return { items: [purchase], next_cursor: null };
      if (path.startsWith('/equipment/')) { changed = true; return {}; }
      throw new Error(path);
    });
    try {
      render(<WardrobeDialog client={{ request }} session={session} onClose={close} onEquipmentSaved={saved} />);
      fireEvent.click(await screen.findByRole('button', { name: `${content.equip} ${purchase.name_snapshot}` }));
      await screen.findByRole('alert');
      expect(screen.getByText(content.equipmentSaved)).toBeInTheDocument();
      expect(document.querySelector('.feedback-pop')).toBeNull();
      expect(screen.getByRole('button', { name: `${content.equip} ${purchase.name_snapshot}` })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: content.close }));
      expect(close).toHaveBeenCalledWith(true);
      failRead = false;
      fireEvent.click(screen.getByRole('button', { name: content.reload }));
      await waitFor(() => expect(saved).toHaveBeenCalledWith(current));
      expect(document.querySelector('.feedback-pop')).not.toBeNull();
      expect(request.mock.calls.filter(([path]) => String(path).startsWith('/equipment'))).toHaveLength(1);
      expect(feedback).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(FEEDBACK_EVENT, feedback);
    }
  });

  it('单件装备写失败后保留其他装备，不播放成功反馈', async () => {
    const existing: Purchase = { ...purchase, id: 'existing', name_snapshot: '已有饰品' };
    const extra: Purchase = { ...purchase, id: 'extra', name_snapshot: '新饰品' };
    const feedback = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, feedback);
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return { ...camp, equipment: { ...equipment, accessories: [existing], accessory_layouts: { existing: { x: 0.5, y: 0.5, size: 0.2, rotation: 0, layer: 1 } } } };
      if (path.startsWith('/purchases?')) return { items: [existing, extra], next_cursor: null };
      if (path === '/equipment/accessories/extra') throw new TypeError('offline');
      throw new Error(path);
    });
    try {
      render(<WardrobeDialog client={{ request }} session={session} onClose={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: `${content.equip} 新饰品` }));
      await screen.findByRole('alert');
      expect(screen.getByRole('button', { name: `${content.unequip} 已有饰品` })).toBeEnabled();
      expect(feedback).not.toHaveBeenCalled();
      expect(request.mock.calls.filter(([path]) => String(path).startsWith('/equipment'))).toEqual([
        ['/equipment/accessories/extra', { method: 'PUT' }],
      ]);
    } finally {
      window.removeEventListener(FEEDBACK_EVENT, feedback);
    }
  });

  it('背景写独立槽位、特效逐件装备，两个操作都保留原饰品', async () => {
    const background: Purchase = { ...purchase, id: 'bg', type_snapshot: 'background', name_snapshot: '草地背景' };
    const effect: Purchase = { ...purchase, id: 'effect', type_snapshot: 'effect', name_snapshot: '雪花特效' };
    let current: Equipment = { ...equipment, accessories: [purchase], accessory_layouts: outfit.accessory_layouts };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return { ...camp, equipment: current };
      if (path.startsWith('/purchases?')) return { items: [background, effect], next_cursor: null };
      if (path === '/equipment/background') { current = { ...current, background }; return {}; }
      if (path === '/equipment/effects/effect') { current = { ...current, effects: [effect] }; return {}; }
      throw new Error(path);
    });
    render(<WardrobeDialog client={{ request }} session={session} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: `${content.equip} ${background.name_snapshot}` }));
    await screen.findByRole('button', { name: `${content.unequip} ${background.name_snapshot}` });
    fireEvent.click(screen.getByRole('button', { name: `${content.equip} ${effect.name_snapshot}` }));
    await screen.findByRole('button', { name: `${content.unequip} ${effect.name_snapshot}` });
    expect(current.accessories).toEqual([purchase]);
    expect(request.mock.calls.filter(([path]) => String(path).startsWith('/equipment'))).toEqual([
      ['/equipment/background', { method: 'PUT', body: { purchase_id: 'bg' } }],
      ['/equipment/effects/effect', { method: 'PUT' }],
    ]);
  });

  it('切换分类隔离迟到分页，保留历史物品的画像用途', async () => {
    let latePage: ((value: { items: Purchase[]; next_cursor: null }) => void) | undefined;
    const historical: Purchase = { ...purchase, id: 'history', type_snapshot: 'island', portrait_type: 'accessory', name_snapshot: '历史双用途饰品' };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/camp') return camp;
      if (path.includes('cursor=')) return new Promise((resolve) => { latePage = resolve; });
      if (path.includes('type=title')) return { items: [], next_cursor: null };
      return { items: [historical], next_cursor: 'page-2' };
    });
    render(<WardrobeDialog client={{ request }} session={session} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: `${content.equip} ${historical.name_snapshot}` });
    fireEvent.click(screen.getByRole('button', { name: content.more }));
    fireEvent.change(screen.getByRole('combobox', { name: content.typeFilter }), { target: { value: 'title' } });
    await screen.findByText(content.emptyPurchases);
    await act(async () => { latePage!({ items: [purchase], next_cursor: null }); });
    expect(screen.queryByRole('button', { name: `${content.equip} ${purchase.name_snapshot}` })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: content.more })).not.toBeInTheDocument();
  });

  it('饰品编辑期间不能关闭外层，放弃确认取消后保留草稿', async () => {
    const close = vi.fn();
    const request = vi.fn().mockImplementation(async (path: string) => path === '/camp'
      ? { ...camp, equipment: outfit }
      : { items: [purchase], next_cursor: null });
    render(<WardrobeDialog client={{ request }} session={session} onClose={close} />);
    fireEvent.click(await screen.findByRole('button', { name: content.editOutfit }));
    const outer = screen.getAllByRole('dialog')[0]!;
    expect(within(outer).getAllByRole('button', { name: content.close })[0]).toBeDisabled();
    fireEvent(outer, new Event('cancel', { bubbles: false, cancelable: true }));
    expect(close).not.toHaveBeenCalled();
    const editor = screen.getByRole('dialog', { name: content.editOutfit });
    fireEvent.click(within(editor).getByRole('button', { name: content.layerBottom }));
    expect(within(editor).getByRole('button', { name: content.save })).toBeEnabled();
    fireEvent.click(within(editor).getByRole('button', { name: content.close }));
    fireEvent.click(screen.getByRole('button', { name: content.keepEditing }));
    expect(within(screen.getByRole('dialog', { name: content.editOutfit })).getByRole('button', { name: content.save })).toBeEnabled();
    expect(close).not.toHaveBeenCalled();
  });
});
