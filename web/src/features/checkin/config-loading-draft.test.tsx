import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Session } from '../../api/types';
import { testSession } from '../../test/account-fixtures';
import { ConfigDialog } from './ConfigDialog';
import { taskFixture } from './test-fixtures';
import content from './content.json';

it.each([13, -1])('图标迟到加载不覆盖已输入的奖励草稿 %s', async (coins) => {
  let finishAssets!: (value: unknown) => void;
  const request = vi.fn().mockImplementation(() => new Promise((resolve) => { finishAssets = resolve; }));
  render(<ConfigDialog client={{ request }} session={testSession as Session} kind="task" item={taskFixture} categories={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(content.coins), { target: { value: String(coins) } });
  fireEvent.change(screen.getByLabelText(content.diamonds), { target: { value: '4' } });
  fireEvent.change(screen.getByLabelText(content.name), { target: { value: '尚未保存的任务' } });
  await act(async () => finishAssets({ items: [{ key: 'book-v1', name: '书本图标', kind: 'icon' }] }));
  expect(screen.getByRole('radio', { name: '书本图标' })).toBeChecked();
  expect(screen.getByLabelText(content.coins)).toHaveValue(coins);
  expect(screen.getByLabelText(content.diamonds)).toHaveValue(4);
  expect(screen.getByLabelText(content.name)).toHaveValue('尚未保存的任务');
  if (coins < 0) {
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    expect(screen.getByLabelText(content.coins)).toBeInvalid();
    expect(request).toHaveBeenCalledTimes(1);
  }
});
