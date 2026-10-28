import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../api/client';
import { FamilyPanel } from './FamilyPanel';
import { SoundPreferences } from './SoundPreferences';
import { testSession } from '../../test/account-fixtures';
import type { Session } from '../../api/types';
const session: Session = { ...testSession, timezone: 'Asia/Taipei' };

describe('家庭留言', () => {
  it('空白不能提交，未知结果使用原文字和原键恢复并保留后来输入', async () => {
    const calls: Array<{ body: unknown; key: unknown }> = [];
    const request = vi.fn().mockImplementation((_path: string, options?: { method?: string; body?: unknown; idempotencyKey?: string }) => {
      if (options?.method === 'POST') {
        calls.push({ body: options.body, key: options.idempotencyKey });
        if (calls.length === 1) return Promise.reject(new ApiFailure(0, { code: 'NETWORK_ERROR', field_errors: {}, request_id: '' }));
        return Promise.resolve({ id: 'message', text: '原留言', created_at: '2026-10-29T04:00:00Z' });
      }
      return Promise.resolve({ items: [], next_cursor: null });
    });
    render(<FamilyPanel client={{ request }} session={session} />);
    await screen.findByText('还没有留言');
    expect(screen.getByRole('button', { name: '发布留言' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('给家人的留言'), { target: { value: '原留言' } });
    fireEvent.click(screen.getByRole('button', { name: '发布留言' }));
    await screen.findByText('发布结果尚未确认，先核对原留言');
    fireEvent.change(screen.getByLabelText('给家人的留言'), { target: { value: '后来输入' } });
    fireEvent.click(screen.getByRole('button', { name: '核对发布结果' }));
    await screen.findByText('留言已发布');
    expect(calls[1]).toEqual(calls[0]);
    expect(screen.getByLabelText('给家人的留言')).toHaveValue('后来输入');
  });

  it('写入成功但列表刷新失败只重试读取', async () => {
    let reads = 0;
    const request = vi.fn().mockImplementation((_path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') return Promise.resolve({ id: 'm', text: '留言', created_at: '2026-10-29T04:00:00Z' });
      if (++reads === 2) return Promise.reject(new Error('offline'));
      return Promise.resolve({ items: [], next_cursor: null });
    });
    render(<FamilyPanel client={{ request }} session={session} />);
    await screen.findByText('还没有留言');
    fireEvent.change(screen.getByLabelText('给家人的留言'), { target: { value: '留言' } });
    fireEvent.click(screen.getByRole('button', { name: '发布留言' }));
    await screen.findByText('留言已发布');
    fireEvent.click(await screen.findByRole('button', { name: '重新加载留言' }));
    await waitFor(() => expect(reads).toBe(3));
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
});

describe('声音与偏好', () => {
  it('只提交本次改变字段，默认不创建音频上下文', async () => {
    const request = vi.fn().mockResolvedValue({ ...testSession.account.preferences, effects_enabled: false });
    const changed = vi.fn();
    render(<SoundPreferences client={{ request }} session={session} onPreferencesChange={changed} />);
    fireEvent.click(screen.getByLabelText('操作音效'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith('/account/preferences', { method: 'PATCH', body: { effects_enabled: false } });
    expect(changed).toHaveBeenCalledWith({ music_enabled: false, effects_enabled: false, reduce_motion: false });
  });
});


it('发布成功响应迟到时，离开页面前后来输入的草稿仍保留', async () => {
  let complete!: (value: unknown) => void;
  const request = vi.fn().mockImplementation((_path: string, options?: { method?: string }) => {
    if (options?.method === 'POST') return new Promise((resolve) => { complete = resolve; });
    return Promise.resolve({ items: [], next_cursor: null });
  });
  const client = { request };
  const first = render(<FamilyPanel client={client} session={session} />);
  await screen.findByText('还没有留言');
  fireEvent.change(screen.getByLabelText('给家人的留言'), { target: { value: '原留言 A' } });
  fireEvent.click(screen.getByRole('button', { name: '发布留言' }));
  fireEvent.change(screen.getByLabelText('给家人的留言'), { target: { value: '后续草稿 B' } });
  first.unmount();
  await act(async () => { complete({ id: 'a', text: '原留言 A', created_at: '2026-10-29T04:00:00Z' }); });
  render(<FamilyPanel client={client} session={session} />);
  await screen.findByText('还没有留言');
  expect(screen.getByLabelText('给家人的留言')).toHaveValue('后续草稿 B');
  expect(screen.getByRole('button', { name: '发布留言' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '核对发布结果' })).not.toBeInTheDocument();
  expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
