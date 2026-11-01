import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../api/client';
import { AppearanceDialog } from './AppearanceDialog';
import { appearanceClient, appearanceFixture, deferred } from './appearance-test-fixtures';
import type { components } from '../../api/schema';

vi.mock('../character/CharacterPreview3D', async () => {
  const { AppearancePreviewFake } = await import('./appearance-test-fixtures');
  return { CharacterPreview3D: AppearancePreviewFake };
});

type AppearanceState = components['schemas']['AppearanceState'];

// 业务交互测试只替换绘制组件，所有草稿、请求及反馈由实际弹窗执行。
async function loadedDialog(handler?: Parameters<typeof appearanceClient>[0]) {
  const state = appearanceFixture();
  const fake = appearanceClient(handler ?? (async (_path, options) => options?.method === 'PUT' ? { ...state, ...options.body as object, version: 2 } : state));
  const onClose = vi.fn(), onSaved = vi.fn();
  const view = render(<AppearanceDialog client={fake.client} onClose={onClose} onSaved={onSaved} />);
  await screen.findByRole('radio', { name: '发型新款' });
  return { ...fake, onClose, onSaved, view };
}

describe('三维外观编辑弹窗', () => {
  it('选择只修改草稿，取消时可以继续编辑或明确放弃且不写入', async () => {
    const { request, onSaved, onClose } = await loadedDialog();
    fireEvent.click(screen.getByRole('radio', { name: '发型新款' }));
    expect(screen.getByTestId('appearance-preview-draft')).toHaveTextContent('hair-purchase');
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByRole('radio', { name: '发型新款' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.every(([, options]) => options?.method !== 'PUT')).toBe(true);
  });

  it('保存提交整套四槽并只发布完整响应，不补读营地', async () => {
    const { request, onSaved } = await loadedDialog();
    fireEvent.click(screen.getByRole('radio', { name: '上衣新款' }));
    fireEvent.click(screen.getByRole('radio', { name: '发型新款' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const write = request.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(write?.[0]).toBe('/appearance');
    expect(write?.[1]?.body).toEqual({ expected_version: 1, character_key: 'body-fixture', hair_purchase_id: 'hair-purchase', upper_purchase_id: 'upper-purchase', lower_purchase_id: null, shoes_purchase_id: null });
    expect(onSaved.mock.calls[0]![0].version).toBe(2);
    expect(request.mock.calls.some(([path]) => path === '/camp')).toBe(false);
    // 保存回调早于画面提交；先等待真实保存反馈，再模拟后续模型失败。
    await screen.findByText('外观已保存。');
    fireEvent.click(screen.getByRole('button', { name: '模拟模型失败' }));
    expect(await screen.findByText('外观已保存，但人物暂时无法显示。请重新加载模型。')).toBeVisible();
    expect(screen.getByRole('button', { name: '保存外观' })).toBeDisabled();
  });

  it('保存期间冻结编辑和关闭，不重复提交', async () => {
    const pending = deferred<AppearanceState>();
    const { request, onClose } = await loadedDialog(async (_path, options) => options?.method === 'PUT' ? pending.promise : appearanceFixture());
    fireEvent.click(screen.getByRole('radio', { name: '鞋子新款' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    expect(screen.getByRole('radio', { name: '发型新款' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '正在保存…' }));
    expect(request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ ...appearanceFixture(2), shoes_purchase_id: 'shoes-purchase' }));
  });

  it('冲突保留草稿，明确读取并核对当前外观后才能继续提交', async () => {
    const latest = { ...appearanceFixture(2), upper_purchase_id: 'upper-purchase' };
    let reads = 0;
    const { request } = await loadedDialog(async (_path, options) => {
      if (options?.method === 'PUT') throw new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' });
      return ++reads === 1 ? appearanceFixture() : latest;
    });
    fireEvent.click(screen.getByRole('radio', { name: '发型新款' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    await screen.findByText('服务器已有较新的外观。你的修改仍保留，请读取当前外观后核对。');
    expect(screen.getByRole('radio', { name: '发型新款' })).toBeChecked();
    expect(screen.getByRole('button', { name: '保存外观' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '读取当前外观' }));
    await screen.findByRole('button', { name: '保留草稿继续编辑' });
    fireEvent.click(screen.getByRole('button', { name: '保留草稿继续编辑' }));
    expect(screen.getByRole('radio', { name: '发型新款' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '上衣新款' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '保存外观' })).toBeEnabled();
    expect(request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });

  it('未知写入先核对结果，已经保存时不再次写入', async () => {
    let reads = 0;
    const saved = { ...appearanceFixture(2), lower_purchase_id: 'lower-purchase' };
    const { request, onSaved } = await loadedDialog(async (_path, options) => {
      if (options?.method === 'PUT') throw new ApiFailure(0, { code: 'NETWORK_ERROR', field_errors: {}, request_id: '' });
      return ++reads === 1 ? appearanceFixture() : saved;
    });
    fireEvent.click(screen.getByRole('radio', { name: '下装新款' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    await screen.findByRole('button', { name: '核对保存结果' });
    fireEvent.click(screen.getByRole('button', { name: '核对保存结果' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });

  it('读取失败可重试，卸载后迟到响应不发布到新弹窗', async () => {
    const first = deferred<AppearanceState>();
    const fake = appearanceClient(async () => first.promise);
    const onSaved = vi.fn();
    const view = render(<AppearanceDialog client={fake.client} onClose={() => {}} onSaved={onSaved} />);
    const signal = fake.request.mock.calls[0]![1]!.signal!;
    view.unmount();
    await act(async () => first.resolve(appearanceFixture()));
    expect(signal.aborted).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
    let reads = 0;
    const retry = appearanceClient(async () => { if (++reads === 1) throw new Error('OFFLINE'); return appearanceFixture(); });
    render(<AppearanceDialog client={retry.client} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '重新读取外观' }));
    expect(await screen.findByRole('radio', { name: '发型新款' })).toBeVisible();
    expect(reads).toBe(2);
  });

  it('默认选项提交显式null，业务拒绝保留草稿且允许修正', async () => {
    const original = { ...appearanceFixture(), hair_purchase_id: 'hair-purchase' };
    const { request } = await loadedDialog(async (_path, options) => {
      if (options.method === 'PUT') throw new ApiFailure(422, { code: 'INVALID_EQUIPMENT', field_errors: {}, request_id: '' });
      return original;
    });
    fireEvent.click(screen.getByRole('radio', { name: '发型默认款（默认）' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存外观' })).toBeEnabled());
    expect(request.mock.calls.find(([, options]) => options?.method === 'PUT')?.[1]?.body).toMatchObject({ hair_purchase_id: null });
    expect(screen.getByRole('radio', { name: '发型默认款（默认）' })).toBeChecked();
    expect(screen.queryByRole('button', { name: '核对保存结果' })).not.toBeInTheDocument();
  });

  it('未知结果核对仍为旧版本时，只能重发完整原请求', async () => {
    let writes = 0;
    const { request, onSaved } = await loadedDialog(async (_path, options) => {
      if (options.method !== 'PUT') return appearanceFixture();
      if (++writes === 1) throw new Error('NETWORK_INTERRUPTED');
      return { ...appearanceFixture(2), shoes_purchase_id: 'shoes-purchase' };
    });
    fireEvent.click(screen.getByRole('radio', { name: '鞋子新款' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    fireEvent.click(await screen.findByRole('button', { name: '核对保存结果' }));
    const retry = await screen.findByRole('button', { name: '再次提交原外观' });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(screen.getByRole('radio', { name: '上衣新款' })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const requests = request.mock.calls.filter(([, options]) => options?.method === 'PUT');
    expect(requests[0]![1]?.body).toEqual(requests[1]![1]?.body);
    expect(requests[1]![1]?.body).toMatchObject({ expected_version: 1, shoes_purchase_id: 'shoes-purchase' });
  });

  it('暂时关闭未知结果后，重开核对而不再写入', async () => {
    let committed = false;
    const saved = { ...appearanceFixture(2), upper_purchase_id: 'upper-purchase' };
    const fake = appearanceClient(async (_path, options) => {
      if (options.method === 'PUT') { committed = true; throw new Error('RESPONSE_LOST'); }
      return committed ? saved : appearanceFixture();
    });
    const firstSaved = vi.fn();
    const first = render(<AppearanceDialog client={fake.client} onClose={() => {}} onSaved={firstSaved} />);
    fireEvent.click(await screen.findByRole('radio', { name: '上衣新款' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    await screen.findByRole('button', { name: '核对保存结果' });
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.getByRole('button', { name: '暂时关闭' })).toBeVisible();
    first.unmount();
    const reopenedSaved = vi.fn();
    render(<AppearanceDialog client={fake.client} onClose={() => {}} onSaved={reopenedSaved} />);
    await waitFor(() => expect(reopenedSaved).toHaveBeenCalledWith(saved));
    expect(firstSaved).not.toHaveBeenCalled();
    expect(fake.request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });

  it('会话客户端替换后，旧PUT迟到不能覆盖新会话', async () => {
    const delayed = deferred<AppearanceState>();
    const old = appearanceClient(async (_path, options) => options.method === 'PUT' ? delayed.promise : appearanceFixture());
    const next = appearanceClient(async () => appearanceFixture(3));
    const onSaved = vi.fn();
    const view = render(<AppearanceDialog client={old.client} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('radio', { name: '发型新款' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    view.rerender(<AppearanceDialog client={next.client} onClose={() => {}} onSaved={onSaved} />);
    await screen.findByRole('radio', { name: '发型默认款（默认）' });
    await act(async () => delayed.resolve({ ...appearanceFixture(2), hair_purchase_id: 'hair-purchase' }));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: '发型默认款（默认）' })).toBeChecked();
  });

  it('冲突核对的GET也在卸载时取消', async () => {
    const delayed = deferred<AppearanceState>();
    let reads = 0;
    const fake = appearanceClient(async (_path, options) => {
      if (options.method === 'PUT') throw new ApiFailure(409, { code: 'VERSION_CONFLICT', field_errors: {}, request_id: '' });
      return ++reads === 1 ? appearanceFixture() : delayed.promise;
    });
    const onSaved = vi.fn();
    const view = render(<AppearanceDialog client={fake.client} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('radio', { name: '发型新款' }));
    fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
    fireEvent.click(await screen.findByRole('button', { name: '读取当前外观' }));
    const signal = fake.request.mock.calls.at(-1)![1]!.signal!;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => delayed.resolve(appearanceFixture(2)));
    expect(onSaved).not.toHaveBeenCalled();
  });
});
