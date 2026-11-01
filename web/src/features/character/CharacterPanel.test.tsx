import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CharacterPanel } from './CharacterPanel';
import { AppearanceProvider } from './AppearanceProvider';
import { appearanceClient, appearanceFixture } from '../shop/appearance-test-fixtures';
import { PublishPanelAppearance, titlePurchase } from './character-panel-test-fixtures';
import content from './character-panel-content.json';

vi.mock('./CharacterPreview3D', async () => ({ CharacterPreview3D: (await import('./character-panel-test-fixtures')).PanelPreviewFake }));

describe('首页共享三维人物', () => {
  it('展示已保存外观、称号成交名称和独立编辑入口，发布保存不重读', async () => {
    const { client, request } = appearanceClient(async () => appearanceFixture());
    const appearance = vi.fn(); const title = vi.fn();
    render(<AppearanceProvider client={client} active><CharacterPanel equipment={{ title: titlePurchase }} displayName="小林" reduceMotion onAppearance={appearance} onTitle={title} /><PublishPanelAppearance /></AppearanceProvider>);
    await screen.findByTestId('saved-character-preview');
    expect(screen.getByRole('heading', { name: '小林' })).toBeInTheDocument();
    expect(screen.getByText(titlePurchase.name_snapshot)).toBeInTheDocument();
    expect(document.querySelector('.character-panel-title img')).toHaveAttribute('src', '/api/v1/assets/title-explorer-v1');
    expect(JSON.parse(screen.getByTestId('saved-character-preview').textContent!).paused).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: content.appearance })); fireEvent.click(screen.getByRole('button', { name: content.title }));
    expect(appearance).toHaveBeenCalledOnce(); expect(title).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: content.appearance }).querySelector('img')).toHaveAttribute('src', '/api/v1/assets/icon-appearance-v1');
    fireEvent.click(screen.getByRole('button', { name: '发布外观快照' }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('saved-character-preview').textContent!).snapshot.version).toBe(2));
    expect(request).toHaveBeenCalledOnce();
  });

  it('触屏点击在打开弹窗前聚焦入口，使关闭后能返回正确按钮', () => {
    const appearance = vi.fn(() => document.activeElement);
    const title = vi.fn(() => document.activeElement);
    render(<><textarea aria-label="留言草稿" /><CharacterPanel equipment={{ title: null }} displayName="小林" onAppearance={appearance} onTitle={title} /></>);
    const previous = screen.getByRole('textbox', { name: '留言草稿' });
    const appearanceButton = screen.getByRole('button', { name: content.appearance });
    const titleButton = screen.getByRole('button', { name: content.title });
    previous.focus();
    fireEvent.click(appearanceButton);
    expect(appearance.mock.results[0]?.value).toBe(appearanceButton);
    previous.focus();
    fireEvent.click(titleButton);
    expect(title.mock.results[0]?.value).toBe(titleButton);
  });

  it('首次读取失败可以显式重试，已有模型在重读失败时保留', async () => {
    let calls = 0;
    const { client } = appearanceClient(async () => { calls += 1; if (calls !== 2) throw new Error('offline'); return appearanceFixture(); });
    render(<AppearanceProvider client={client} active><CharacterPanel equipment={{ title: null }} displayName="小林" /><PublishPanelAppearance /></AppearanceProvider>);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: content.retry }));
    await screen.findByTestId('saved-character-preview');
    fireEvent.click(screen.getByRole('button', { name: '刷新外观快照' }));
    await screen.findByRole('alert');
    expect(screen.getByTestId('saved-character-preview')).toBeInTheDocument();
    expect(screen.queryByText(titlePurchase.name_snapshot)).toBeNull();
  });
});
