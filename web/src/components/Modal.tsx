import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import content from '../content/zh-CN.json';

// 原生dialog负责模态焦点约束；卸载后将焦点还给原入口。
export function Modal({ title, children, onClose, closeDisabled = false }: { title: string; children: ReactNode; onClose: () => void; closeDisabled?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); opener.current?.focus(); };
  }, []);
  // 外部轻触不产生关闭请求；关闭按钮与Escape继续交给业务处理草稿和提交状态。
  return <dialog ref={dialog} className="island-dialog" closedby="closerequest" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!closeDisabled) onClose(); }}>
    <div className="dialog-header"><h2 id={titleId}>{title}</h2><button type="button" className="secondary" disabled={closeDisabled} onClick={onClose}>{content.common.close}</button></div>
    {children}
  </dialog>;
}
