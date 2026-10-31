import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessoryEditor } from './AccessoryEditor';
import { outfit, purchase } from './test-fixtures';
import { dispatchAccessoryPointer, installAccessoryPointerSurface } from './accessory-pointer-test-helpers';
import content from './content.json';

// 每个操作都经过编辑器草稿和真实React事件处理，再检查预览与保存请求。
function openEditor(request = vi.fn().mockResolvedValue(outfit)) {
  const view = render(<AccessoryEditor equipment={outfit} displayName="小朋友" client={{ request }} onSaved={vi.fn()} onClose={vi.fn()} />);
  return {
    ...view,
    image: screen.getByAltText(purchase.name_snapshot),
    move: screen.getByRole('button', { name: `${content.selectAccessory} ${purchase.name_snapshot}` }),
    resize: view.container.querySelector<HTMLButtonElement>('[data-transform="resize"][data-corner="se"]')!,
    rotate: screen.getByRole('button', { name: `${content.rotateAccessory} ${purchase.name_snapshot}` }),
  };
}

describe('饰品画布手势', () => {
  let restoreSurface: () => void;
  beforeEach(() => { restoreSurface = installAccessoryPointerSurface(); });
  afterEach(() => restoreSurface());

  it('点击另一件饰品同步下拉框，但选中状态不改变主体命中顺序', () => {
    const { move, image } = openEditor();
    const other = screen.getByRole('button', { name: `${content.selectAccessory} 帽子` });
    expect(Number(move.style.zIndex)).toBeLessThan(Number(other.style.zIndex));
    fireEvent.click(other);
    expect(screen.getByLabelText(content.selectedAccessory)).toHaveValue('second');
    fireEvent.click(move);
    expect(screen.getByLabelText(content.selectedAccessory)).toHaveValue(purchase.id);
    expect(Number(move.style.zIndex)).toBeLessThan(Number(other.style.zIndex));
    expect(image.style.left).toBe('50%');
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
  });

  it('下拉框给被遮挡饰品一次优先手势，恢复命中顺序后仍拖动原对象', () => {
    const { move, image } = openEditor();
    const selection = screen.getByLabelText(content.selectedAccessory);
    const other = screen.getByRole('button', { name: `${content.selectAccessory} 帽子` });
    fireEvent.change(selection, { target: { value: 'second' } });
    fireEvent.change(selection, { target: { value: purchase.id } });
    expect(Number(move.style.zIndex)).toBeGreaterThan(Number(other.style.zIndex));
    dispatchAccessoryPointer(move, 'pointerdown', 150, 150);
    expect(Number(move.style.zIndex)).toBeLessThan(Number(other.style.zIndex));
    dispatchAccessoryPointer(move, 'pointermove', 180, 150);
    dispatchAccessoryPointer(move, 'pointermove', 195, 150);
    dispatchAccessoryPointer(move, 'pointerup', 195, 150);
    fireEvent.click(move);
    expect(selection).toHaveValue(purchase.id);
    expect(image.style.left).toBe('65%');
    expect(screen.getByAltText('帽子').style.left).toBe('20%');
  });

  it.each(['pointer', 'keyboard'])('通过下拉框%s操作同一项可以再次优先，空白操作不消耗', (input) => {
    const { move, container } = openEditor();
    const selection = screen.getByLabelText(content.selectedAccessory);
    const other = screen.getByRole('button', { name: `${content.selectAccessory} 帽子` });
    const activate = () => input === 'pointer'
      ? dispatchAccessoryPointer(selection, 'pointerdown', 0, 0)
      : fireEvent.keyDown(selection, { key: 'Enter' });
    activate();
    fireEvent.click(container.querySelector('.shop-character-stage')!);
    expect(Number(move.style.zIndex)).toBeGreaterThan(Number(other.style.zIndex));
    fireEvent.click(move);
    expect(Number(move.style.zIndex)).toBeLessThan(Number(other.style.zIndex));
    activate();
    expect(Number(move.style.zIndex)).toBeGreaterThan(Number(other.style.zIndex));
    fireEvent.click(other);
    expect(selection).toHaveValue('second');
    fireEvent.click(move);
    expect(Number(move.style.zIndex)).toBeLessThan(Number(other.style.zIndex));
  });

  it('下拉框切换经草稿确认后才给目标优先，继续编辑保留原草稿', () => {
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: `${content.selectAccessory} 帽子` }));
    fireEvent.keyDown(screen.getByRole('button', { name: `${content.selectAccessory} 帽子` }), { key: 'ArrowRight' });
    fireEvent.change(screen.getByLabelText(content.selectedAccessory), { target: { value: purchase.id } });
    fireEvent.click(screen.getByRole('button', { name: content.keepEditing }));
    expect(screen.getByLabelText(content.selectedAccessory)).toHaveValue('second');
    expect(Number.parseFloat(screen.getByAltText('帽子').style.left)).toBeCloseTo(21);
    fireEvent.change(screen.getByLabelText(content.selectedAccessory), { target: { value: purchase.id } });
    fireEvent.click(screen.getByRole('button', { name: content.discard }));
    const selected = screen.getByRole('button', { name: `${content.selectAccessory} ${purchase.name_snapshot}` });
    const other = screen.getByRole('button', { name: `${content.selectAccessory} 帽子` });
    expect(Number(selected.style.zIndex)).toBeGreaterThan(Number(other.style.zIndex));
    expect(screen.getByAltText('帽子').style.left).toBe('20%');
    fireEvent.click(selected);
    expect(Number(selected.style.zIndex)).toBeLessThan(Number(other.style.zIndex));
  });

  it('取消首次手势恢复布局，但不恢复已用掉的优先机会', () => {
    const { move, image } = openEditor();
    dispatchAccessoryPointer(screen.getByLabelText(content.selectedAccessory), 'pointerdown', 0, 0);
    const other = screen.getByRole('button', { name: `${content.selectAccessory} 帽子` });
    expect(Number(move.style.zIndex)).toBeGreaterThan(Number(other.style.zIndex));
    dispatchAccessoryPointer(move, 'pointerdown', 150, 150);
    dispatchAccessoryPointer(move, 'pointermove', 180, 150);
    dispatchAccessoryPointer(move, 'pointercancel', 180, 150);
    expect(image.style.left).toBe('50%');
    expect(Number(move.style.zIndex)).toBeLessThan(Number(other.style.zIndex));
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
  });

  it('鼠标拖动主体、角点和旋转手柄，提交同一份几何与层级', async () => {
    const request = vi.fn().mockResolvedValue(outfit);
    const { image, move, resize, rotate } = openEditor(request);
    dispatchAccessoryPointer(move, 'pointerdown', 150, 150);
    dispatchAccessoryPointer(move, 'pointermove', 180, 165);
    dispatchAccessoryPointer(move, 'pointerup', 180, 165);
    expect(image.style.left).toBe('60%');
    expect(Number.parseFloat(image.style.top)).toBeCloseTo(55);
    dispatchAccessoryPointer(resize, 'pointerdown', 210, 195);
    dispatchAccessoryPointer(resize, 'pointermove', 225, 210);
    dispatchAccessoryPointer(resize, 'pointerup', 225, 210);
    expect(Number.parseFloat(image.style.width)).toBeCloseTo(30);
    expect(image.style.height).toBe(image.style.width);
    dispatchAccessoryPointer(rotate, 'pointerdown', 180, 80);
    dispatchAccessoryPointer(rotate, 'pointermove', 265, 165);
    dispatchAccessoryPointer(rotate, 'pointerup', 265, 165);
    expect(image.style.transform).toBe('translate(-50%, -50%) rotate(90deg)');
    expect(move.style.transform).toBe(image.style.transform);
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    expect(request).toHaveBeenCalledWith(`/equipment/accessories/${purchase.id}/layout`, {
      method: 'PATCH', body: { x: expect.closeTo(0.6, 8), y: expect.closeTo(0.55, 8), size: expect.closeTo(0.3, 8), rotation: 90, before_id: 'second' },
    });
    await screen.findByText(content.equipmentSaved);
  });

  it.each(['pointercancel', 'lostpointercapture'])('%s 恢复手势开始前的位置、大小和角度', (event) => {
    const { image, rotate } = openEditor();
    dispatchAccessoryPointer(rotate, 'pointerdown', 150, 75);
    dispatchAccessoryPointer(rotate, 'pointermove', 225, 150);
    expect(image.style.transform).toBe('translate(-50%, -50%) rotate(90deg)');
    dispatchAccessoryPointer(rotate, event, 225, 150);
    expect(image.style.left).toBe('50%');
    expect(image.style.top).toBe('50%');
    expect(image.style.width).toBe('20%');
    expect(image.style.transform).toBe('translate(-50%, -50%) rotate(0deg)');
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
  });

  it('正常结束后失去指针捕获不会撤销已经完成的移动，第二个指针不能接管', () => {
    const { image, move } = openEditor();
    dispatchAccessoryPointer(move, 'pointerdown', 150, 150);
    dispatchAccessoryPointer(move, 'pointermove', 270, 270, 2);
    expect(image.style.left).toBe('50%');
    dispatchAccessoryPointer(move, 'pointermove', 180, 150);
    dispatchAccessoryPointer(move, 'pointerup', 180, 150);
    dispatchAccessoryPointer(move, 'lostpointercapture', 180, 150);
    expect(image.style.left).toBe('60%');
    expect(screen.getByRole('button', { name: content.save })).toBeEnabled();
  });

  it('大素材旋转后收进画布，来回旋转从起始布局计算而不会累计缩小', () => {
    const { image, resize, rotate } = openEditor();
    fireEvent.keyDown(resize, { key: 'End' });
    expect(image.style.width).toBe('100%');
    dispatchAccessoryPointer(rotate, 'pointerdown', 150, 0);
    dispatchAccessoryPointer(rotate, 'pointermove', 300, 0);
    expect(Number.parseFloat(image.style.width)).toBeCloseTo(100 / Math.sqrt(2));
    expect(image.style.transform).toBe('translate(-50%, -50%) rotate(45deg)');
    dispatchAccessoryPointer(rotate, 'pointermove', 150, 0);
    expect(image.style.width).toBe('100%');
    expect(image.style.transform).toBe('translate(-50%, -50%) rotate(0deg)');
    dispatchAccessoryPointer(rotate, 'pointerup', 150, 0);
  });

  it('旋转后沿角点方向缩放仍保持等比，取消缩放恢复完整布局', () => {
    const { image, resize, rotate } = openEditor();
    dispatchAccessoryPointer(rotate, 'pointerdown', 150, 75);
    dispatchAccessoryPointer(rotate, 'pointermove', 225, 150);
    dispatchAccessoryPointer(rotate, 'pointerup', 225, 150);
    dispatchAccessoryPointer(resize, 'pointerdown', 120, 180);
    dispatchAccessoryPointer(resize, 'pointermove', 105, 195);
    expect(Number.parseFloat(image.style.width)).toBeCloseTo(30);
    expect(image.style.width).toBe(image.style.height);
    dispatchAccessoryPointer(resize, 'pointercancel', 105, 195);
    expect(image.style.width).toBe('20%');
    expect(image.style.transform).toBe('translate(-50%, -50%) rotate(90deg)');
  });

  it('保存期间禁用手势、键盘和层级控制，保持已提交的预览', () => {
    const request = vi.fn(() => new Promise<never>(() => {}));
    const { image, move, resize, rotate } = openEditor(request);
    dispatchAccessoryPointer(move, 'pointerdown', 150, 150);
    dispatchAccessoryPointer(move, 'pointermove', 153, 150);
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    dispatchAccessoryPointer(move, 'lostpointercapture', 153, 150);
    expect(move).toBeDisabled();
    expect(resize).toBeDisabled();
    expect(rotate).toBeDisabled();
    expect(screen.getByRole('button', { name: content.layerDown })).toBeDisabled();
    dispatchAccessoryPointer(move, 'pointerdown', 153, 150);
    dispatchAccessoryPointer(move, 'pointermove', 240, 240);
    fireEvent.keyDown(move, { key: 'ArrowRight' });
    fireEvent.keyDown(resize, { key: 'End' });
    fireEvent.keyDown(rotate, { key: 'ArrowRight' });
    expect(image.style.left).toBe('51%');
    expect(image.style.top).toBe('50%');
    expect(image.style.width).toBe('20%');
    expect(image.style.transform).toBe('translate(-50%, -50%) rotate(0deg)');
    expect(request).toHaveBeenCalledOnce();
  });
});
