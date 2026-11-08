import { fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { expect, it, vi } from 'vitest';
import { AppearancePage } from './AppearancePage';
import type { AppearanceLeaveGuard } from './AppearancePage';
import { appearanceClient, appearanceFixture } from './appearance-test-fixtures';

vi.mock('../character/CharacterPreview3D', async () => {
  const { AppearancePreviewFake } = await import('./appearance-test-fixtures');
  return { CharacterPreview3D: AppearancePreviewFake };
});

it('在独立页面保留草稿，并由导航请求确认放弃', async () => {
  const { client, request } = appearanceClient(async () => appearanceFixture());
  const leave = vi.fn();
  function App() {
    const leaveGuardRef = useRef<AppearanceLeaveGuard>(null);
    return <>
      <button onClick={() => leaveGuardRef.current?.(leave)}>打卡</button>
      <AppearancePage client={client} onSaved={vi.fn()} leaveGuardRef={leaveGuardRef} />
    </>;
  }
  render(<App />);
  const tabs = await screen.findByRole('tablist');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(within(tabs).getByRole('tab', { name: '头部' }));
  fireEvent.click(screen.getByRole('radio', { name: '头部新款' }));
  fireEvent.click(screen.getByRole('button', { name: '打卡' }));
  expect(leave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(screen.getByRole('radio', { name: '头部新款' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '打卡' }));
  fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
  expect(leave).toHaveBeenCalledOnce();
  expect(request.mock.calls.every(([, options]) => options?.method !== 'PUT')).toBe(true);
});

it('分类筛选后能直接跳页，切换分类后仍保留所选装扮', async () => {
  const state = appearanceFixture();
  const upper = state.wearables.find((item) => item.wearable_key === 'upper-owned')!;
  for (let index = 1; index <= 27; index += 1) {
    const key = `extra-upper-${index}`;
    state.wearables.push({ ...upper, name: `额外上装 ${index}`, wearable_key: key });
    state.inventory.push({ purchase_id: key, wearable_key: key });
  }
  const { client } = appearanceClient(async () => state);
  render(<AppearancePage client={client} onSaved={vi.fn()} leaveGuardRef={null} />);
  fireEvent.click(await screen.findByRole('tab', { name: '上装' }));
  expect(screen.getByRole('radio', { name: '上装默认款' })).toBeChecked();
  const pager = screen.getByRole('navigation', { name: '分页' });
  fireEvent.change(within(pager).getByRole('spinbutton', { name: '页码' }), { target: { value: '3' } });
  fireEvent.click(within(pager).getByRole('button', { name: '跳转' }));
  expect(screen.queryByRole('radio', { name: '上装默认款' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: '额外上装 27' }));
  fireEvent.click(screen.getByRole('tab', { name: '鞋子' }));
  expect(screen.getByRole('radio', { name: '鞋子新款' })).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: '分页' })).not.toBeInTheDocument();
  expect(screen.getByTestId('appearance-preview-draft')).toHaveTextContent('extra-upper-27');
});

it('复用请求客户端时隔离不同账号的未知保存', async () => {
  const { client, request } = appearanceClient(async (_path, options) => {
    if (options.method === 'PUT') throw new Error('RESPONSE_LOST');
    return appearanceFixture();
  });
  const first = render(<AppearancePage client={client} accountID={1} onSaved={vi.fn()} leaveGuardRef={null} />);
  fireEvent.click(await screen.findByRole('tab', { name: '上装' }));
  fireEvent.click(screen.getByRole('radio', { name: '上装新款' }));
  fireEvent.click(screen.getByRole('button', { name: '保存外观' }));
  await screen.findByRole('button', { name: '核对保存结果' });
  first.unmount();

  render(<AppearancePage client={client} accountID={2} onSaved={vi.fn()} leaveGuardRef={null} />);
  fireEvent.click(await screen.findByRole('tab', { name: '上装' }));
  expect(screen.getByRole('radio', { name: '上装默认款' })).toBeChecked();
  expect(screen.getByRole('radio', { name: '上装新款' })).toBeEnabled();
  expect(request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
});
