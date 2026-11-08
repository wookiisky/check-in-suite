import type { SubmitEvent } from 'react';
import content from './numbered-pagination-content.json';
import './numbered-pagination.css';

// 页码可直接输入，翻页和跳转共用同一回调。
export function NumberedPagination({ page, totalPages, onPageChange, disabled = false }: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
}) {
  if (totalPages <= 1) return null;

  // 原生表单负责键盘提交和输入范围，当前页不重复请求。
  function jump(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(new FormData(event.currentTarget).get('page'));
    if (!disabled && Number.isInteger(value) && value >= 1 && value <= totalPages && value !== page) onPageChange(value);
  }
  return <nav aria-label={content.label} className="numbered-pagination">
    <button type="button" className="secondary" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>{content.previous}</button>
    <span aria-current="page">{content.range.replace('{page}', String(page)).replace('{total}', String(totalPages))}</span>
    <button type="button" className="secondary" disabled={disabled || page >= totalPages} onClick={() => onPageChange(page + 1)}>{content.next}</button>
    <form className="numbered-pagination-jump" onSubmit={jump}>
      <label>{content.page}<input key={page} type="number" name="page" min={1} max={totalPages} step={1} required defaultValue={page} disabled={disabled} /></label>
      <button type="submit" className="secondary" disabled={disabled}>{content.jump}</button>
    </form>
  </nav>;
}
