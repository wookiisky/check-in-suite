import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';
import content from '../content/zh-CN.json';

describe('公共弹窗关闭规则', () => {
  it('禁止外部点击关闭，同时允许显式关闭请求', () => {
    const close = vi.fn();
    render(<Modal title={content.navigation.management} onClose={close}>{null}</Modal>);
    expect(screen.getByRole('dialog')).toHaveAttribute('closedby', 'closerequest');
    fireEvent.click(screen.getByRole('button', { name: content.common.close }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('Escape 的取消请求由业务处理，并阻止浏览器直接关闭', () => {
    const close = vi.fn();
    render(<Modal title={content.navigation.management} onClose={close}>{null}</Modal>);
    const dialog = screen.getByRole('dialog');
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveAttribute('open');
  });

  it('提交期间关闭按钮与取消请求均不能关闭弹窗', () => {
    const close = vi.fn();
    render(<Modal title={content.navigation.management} onClose={close} closeDisabled>{null}</Modal>);
    const dialog = screen.getByRole('dialog');
    const button = within(dialog).getByRole('button', { name: content.common.close });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(close).not.toHaveBeenCalled();
  });
});
