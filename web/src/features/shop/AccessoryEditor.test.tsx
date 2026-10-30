import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FEEDBACK_EVENT } from '../../feedback/feedback-events';
import { AccessoryEditor } from './AccessoryEditor';
import { CharacterPanel } from './CharacterPanel';
import { camp, equipment, outfit, purchase } from './test-fixtures';
import { ApiFailure } from '../../api/client';
import content from './content.json';

// 通过选框手柄调整大小，测试操作与页面的键盘入口一致。
function resizeTo(percent: number) {
  const handle = screen.getAllByRole('button', { name: `${content.resizeAccessory} ${purchase.name_snapshot}` })[0]!;
  fireEvent.keyDown(handle, { key: 'Home' });
  for (let value = 5; value < percent; value++) fireEvent.keyDown(handle, { key: 'ArrowRight' });
}

// 角度也通过画布的键盘入口修改，便于核对草稿恢复与请求内容。
function rotateTo(degrees: number) {
  const handle = screen.getByRole('button', { name: `${content.rotateAccessory} ${purchase.name_snapshot}` });
  fireEvent.keyDown(handle, { key: 'Home' });
  for (let value = 0; value < degrees; value++) fireEvent.keyDown(handle, { key: 'ArrowRight' });
}

describe('饰品编辑', () => {
  it('移除方向按钮与尺寸滑杆，保留层级按钮和画布操作入口', () => {
    render(<AccessoryEditor equipment={outfit} displayName="小朋友" client={{ request: vi.fn() }} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: content.moveRight })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: `${content.resizeAccessory} ${purchase.name_snapshot}` })).toHaveLength(4);
    expect(screen.getByRole('button', { name: `${content.rotateAccessory} ${purchase.name_snapshot}` })).toBeEnabled();
    expect(screen.getByRole('button', { name: content.layerDown })).toBeEnabled();
    expect(screen.getByRole('button', { name: content.layerBottom })).toBeEnabled();
  });
  it('逐层穿过角色并只保存选中饰品的位置、尺寸和最终顺序', async () => {
    const feedback = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, feedback);
    const request = vi.fn().mockResolvedValue(outfit);
    render(<AccessoryEditor equipment={outfit} displayName="小朋友" client={{ request }} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: `${content.selectAccessory} ${purchase.name_snapshot}` }), { key: 'ArrowRight' });
    resizeTo(30);
    fireEvent.click(screen.getByRole('button', { name: content.layerDown }));
    const drawing = screen.getByAltText(purchase.name_snapshot);
    const avatar = screen.getByRole('img', { name: content.baseAvatarNames['avatar-boy-v2'] });
    expect(Number(drawing.style.zIndex)).toBeLessThan(Number(avatar.style.zIndex));
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/equipment/accessories/${purchase.id}/layout`, {
      method: 'PATCH', body: { x: 0.51, y: 0.5, size: expect.closeTo(0.3, 8), rotation: 0, before_id: 'avatar' },
    }));
    expect(await screen.findByText(content.equipmentSaved)).toHaveClass('feedback-success');
    expect(feedback).toHaveBeenCalledTimes(1);
    expect(feedback.mock.calls[0]?.[0].detail).toBe('equip');
    window.removeEventListener(FEEDBACK_EVENT, feedback);
  });

  it('取消恢复草稿；保存失败保留草稿，切换饰品前要求处理未保存内容', async () => {
    const feedback = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, feedback);
    const request = vi.fn().mockRejectedValue(new TypeError('offline'));
    render(<AccessoryEditor equipment={outfit} displayName="小朋友" client={{ request }} onSaved={vi.fn()} onClose={vi.fn()} />);
    resizeTo(40);
    rotateTo(45);
    fireEvent.click(screen.getByRole('button', { name: content.cancel }));
    expect(screen.getByLabelText(content.accessorySize)).toHaveTextContent('20%');
    expect(screen.getByLabelText(content.accessoryRotation)).toHaveTextContent('0°');
    resizeTo(40);
    rotateTo(45);
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText(content.accessorySize)).toHaveTextContent('40%');
    expect(screen.getByLabelText(content.accessoryRotation)).toHaveTextContent('45°');
    fireEvent.change(screen.getByLabelText(content.selectedAccessory), { target: { value: 'second' } });
    expect(screen.getByText(content.discardChanges)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.keepEditing }));
    expect(screen.getByLabelText(content.selectedAccessory)).toHaveValue(purchase.id);
    expect(screen.getByLabelText(content.accessorySize)).toHaveTextContent('40%');
    expect(screen.getByLabelText(content.accessoryRotation)).toHaveTextContent('45°');
    expect(feedback).not.toHaveBeenCalled();
    window.removeEventListener(FEEDBACK_EVENT, feedback);
  });

  it('键盘微调与缩放限制在画布内，图片容器保持等比', () => {
    render(<AccessoryEditor equipment={outfit} displayName="小朋友" client={{ request: vi.fn() }} onSaved={vi.fn()} onClose={vi.fn()} />);
    const button = screen.getByRole('button', { name: `${content.selectAccessory} ${purchase.name_snapshot}` });
    fireEvent.keyDown(button, { key: 'ArrowRight' });
    expect(screen.getByAltText(purchase.name_snapshot).style.left).toBe('51%');
    resizeTo(100);
    const image = screen.getByAltText(purchase.name_snapshot);
    expect(image.style.left).toBe('50%');
    expect(image.style.top).toBe('50%');
    expect(image.style.width).toBe('100%');
    expect(image.style.height).toBe('100%');
  });

  it('背景和特效固定渲染，不能选择编辑，减少动效使用静态素材', () => {
    render(<CharacterPanel equipment={outfit} displayName="小朋友" reduceMotion />);
    expect(screen.getByAltText('草地')).toHaveClass('shop-background-art');
    expect(screen.getByAltText('下雪')).toHaveAttribute('src', '/api/v1/assets/effect-snow-v1?motion=static');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('排序目标卸下后从营地刷新，保留位置大小并重新确认可用顺序', async () => {
    const feedback = vi.fn();
    window.addEventListener(FEEDBACK_EVENT, feedback);
    const latest = { ...outfit, accessories: [purchase], accessory_layouts: { [purchase.id]: outfit.accessory_layouts[purchase.id]! } };
    const request = vi.fn()
      .mockRejectedValueOnce(new ApiFailure(409, { code: 'EQUIPMENT_CHANGED', field_errors: {}, request_id: '' }))
      .mockResolvedValueOnce({ ...camp, equipment: latest })
      .mockResolvedValueOnce(latest);
    render(<AccessoryEditor equipment={outfit} displayName="小朋友" client={{ request }} onSaved={vi.fn()} onClose={vi.fn()} />);
    resizeTo(35);
    rotateTo(30);
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByText(content.errors.EQUIPMENT_CHANGED);
    fireEvent.click(screen.getByRole('button', { name: content.reloadEquipment }));
    await screen.findByText(content.reviewLayout);
    expect(feedback).not.toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(2, '/camp');
    expect(screen.getByLabelText(content.accessorySize)).toHaveTextContent('35%');
    expect(screen.getByLabelText(content.accessoryRotation)).toHaveTextContent('30°');
    expect(screen.queryByRole('option', { name: '帽子' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await waitFor(() => expect(request).toHaveBeenNthCalledWith(3, `/equipment/accessories/${purchase.id}/layout`, {
      method: 'PATCH', body: { x: 0.5, y: 0.5, size: expect.closeTo(0.35, 8), rotation: 30, before_id: null },
    }));
    expect(feedback).toHaveBeenCalledTimes(1);
    window.removeEventListener(FEEDBACK_EVENT, feedback);
  });

  it('反复换装使层号增长后特效仍高于全部饰品，编辑操作高于特效', () => {
    const highLayerOutfit = { ...outfit, accessory_layouts: { ...outfit.accessory_layouts, second: { x: 0.2, y: 0.3, size: 0.15, rotation: 0, layer: 500 } } };
    render(<AccessoryEditor equipment={highLayerOutfit} displayName="小朋友" client={{ request: vi.fn() }} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(Number(screen.getByAltText('下雪').style.zIndex)).toBeGreaterThan(Number(screen.getByAltText('帽子').style.zIndex));
    expect(Number(screen.getByRole('button', { name: `${content.selectAccessory} 帽子` }).style.zIndex)).toBeGreaterThan(Number(screen.getByAltText('下雪').style.zIndex));
  });

  it('当前饰品全部被卸下后刷新仍保留草稿，禁用保存并允许关闭', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new ApiFailure(409, { code: 'EQUIPMENT_CHANGED', field_errors: {}, request_id: '' }))
      .mockResolvedValueOnce({ ...camp, equipment });
    const onClose = vi.fn();
    render(<AccessoryEditor equipment={outfit} displayName="小朋友" client={{ request }} onSaved={vi.fn()} onClose={onClose} />);
    resizeTo(35);
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    await screen.findByText(content.errors.EQUIPMENT_CHANGED);
    fireEvent.click(screen.getByRole('button', { name: content.reloadEquipment }));
    await screen.findByText(content.accessoryNoLongerEquipped);
    expect(screen.getByLabelText(content.accessorySize)).toHaveTextContent('35%');
    expect(screen.getByRole('button', { name: content.save })).toBeDisabled();
    expect(screen.getByRole('button', { name: content.cancel })).toBeDisabled();
    expect(screen.queryByAltText(purchase.name_snapshot)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: content.close }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('系统减少动效设置变化时即时切换到静态文件', () => {
    const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(media));
    try {
      const view = render(<CharacterPanel equipment={outfit} displayName="小朋友" />);
      expect(screen.getByAltText('下雪')).toHaveAttribute('src', '/api/v1/assets/effect-snow-v1');
      act(() => {
        media.matches = true;
        const notify = media.addEventListener.mock.calls[0]?.[1] as () => void;
        notify();
      });
      expect(screen.getByAltText('下雪')).toHaveAttribute('src', '/api/v1/assets/effect-snow-v1?motion=static');
      view.unmount();
      expect(media.removeEventListener).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
