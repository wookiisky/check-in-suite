import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppearanceProvider, useAppearance } from './AppearanceProvider';
import { appearanceClient, appearanceFixture, deferred } from '../shop/appearance-test-fixtures';
import type { components } from '../../api/schema';

type AppearanceState = components['schemas']['AppearanceState'];

// 以真实消费者观察共享状态，避免只测试内部 setState 调用。
function Consumer() {
  const appearance = useAppearance();
  return <><output data-testid="snapshot">{JSON.stringify(appearance.snapshot)}</output><output data-testid="loading">{String(appearance.loading)}</output><output data-testid="error">{String(appearance.error !== null)}</output><button onClick={() => void appearance.refresh()}>刷新外观</button><button onClick={() => appearance.publishSaved(appearanceFixture(3))}>发布保存</button></>;
}

describe('已保存外观共享快照', () => {
  it('未登录时不读取，同版本读取可更新库存', async () => {
    const first = appearanceFixture();
    const second = { ...appearanceFixture(), inventory: [] };
    let calls = 0;
    const { client, request } = appearanceClient(async () => ++calls === 1 ? first : second);
    const view = render(<AppearanceProvider client={client} active={false}><Consumer /></AppearanceProvider>);
    expect(request).not.toHaveBeenCalled();
    view.rerender(<AppearanceProvider client={client} active><Consumer /></AppearanceProvider>);
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('hair-purchase'));
    fireEvent.click(screen.getByText('刷新外观'));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('snapshot').textContent!).inventory).toEqual([]));
    view.rerender(<AppearanceProvider client={client} active={false}><Consumer /></AppearanceProvider>);
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('null'));
  });

  it('新读取先完成后，旧读取与较低版本都不能回退状态', async () => {
    const older = deferred<AppearanceState>();
    const newer = deferred<AppearanceState>();
    let calls = 0;
    const { client } = appearanceClient(async () => ++calls === 1 ? older.promise : calls === 2 ? newer.promise : appearanceFixture(1));
    render(<AppearanceProvider client={client} active><Consumer /></AppearanceProvider>);
    fireEvent.click(screen.getByText('刷新外观'));
    await act(async () => newer.resolve(appearanceFixture(2)));
    await act(async () => older.resolve(appearanceFixture(1)));
    expect(JSON.parse(screen.getByTestId('snapshot').textContent!).version).toBe(2);
    fireEvent.click(screen.getByText('刷新外观'));
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(JSON.parse(screen.getByTestId('snapshot').textContent!).version).toBe(2);
  });

  it('保存发布使正在读取的旧快照失效，卸载取消请求', async () => {
    const pending = deferred<AppearanceState>();
    const { client, request } = appearanceClient(async () => pending.promise);
    const view = render(<AppearanceProvider client={client} active><Consumer /></AppearanceProvider>);
    fireEvent.click(screen.getByText('发布保存'));
    await act(async () => pending.resolve(appearanceFixture(1)));
    expect(JSON.parse(screen.getByTestId('snapshot').textContent!).version).toBe(3);
    fireEvent.click(screen.getByText('刷新外观'));
    const signal = request.mock.calls.at(-1)![1]!.signal!;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it('读取失败保留已确认外观，后续同版本读取可恢复', async () => {
    let calls = 0;
    const { client } = appearanceClient(async () => {
      calls += 1;
      if (calls === 2) throw new Error('OFFLINE');
      return { ...appearanceFixture(), inventory: calls > 2 ? [] : appearanceFixture().inventory };
    });
    render(<AppearanceProvider client={client} active><Consumer /></AppearanceProvider>);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    fireEvent.click(screen.getByText('刷新外观'));
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('true'));
    expect(JSON.parse(screen.getByTestId('snapshot').textContent!).inventory).toHaveLength(4);
    fireEvent.click(screen.getByText('刷新外观'));
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('false'));
    expect(JSON.parse(screen.getByTestId('snapshot').textContent!).inventory).toHaveLength(0);
  });
});
