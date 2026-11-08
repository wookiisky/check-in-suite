import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CharacterPanel } from './CharacterPanel';
import { AppearanceProvider } from './AppearanceProvider';
import { appearanceClient, appearanceFixture } from '../shop/appearance-test-fixtures';
import { PublishPanelAppearance } from './character-panel-test-fixtures';
import content from './character-panel-content.json';

vi.mock('./CharacterPreview3D', async () => ({ CharacterPreview3D: (await import('./character-panel-test-fixtures')).PanelPreviewFake }));

describe('首页共享三维人物', () => {
  it('展示用户名、可旋转外观和成就入口，发布保存不重读', async () => {
    const { client, request } = appearanceClient(async () => appearanceFixture());
    const openAchievements = vi.fn();
    render(<AppearanceProvider client={client} active>
      <CharacterPanel username="camp-user" title="阅读达人" reduceMotion onAchievements={openAchievements} badgeToggle={<button>成就徽章</button>} />
      <PublishPanelAppearance />
    </AppearanceProvider>);
    const preview = await screen.findByTestId('saved-character-preview');
    expect(screen.getByRole('heading', { name: 'camp-user' })).toBeInTheDocument();
    expect(screen.getByText('阅读达人')).toHaveClass('character-panel-title');
    expect(screen.queryByRole('button', { name: '阅读达人' })).not.toBeInTheDocument();
    expect(JSON.parse(preview.textContent!)).toMatchObject({ paused: true, rotatable: true, showRotationControls: false });
    expect(preview.parentElement).toContainElement(screen.getByRole('button', { name: '成就徽章' }));
    const achievement = screen.getByRole('button', { name: content.achievements });
    expect(achievement.querySelector('img')).toHaveAttribute('src', '/api/v1/assets/crown-v1');
    fireEvent.click(achievement);
    expect(openAchievements).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '发布外观快照' }));
    await waitFor(() => expect(JSON.parse(preview.textContent!).snapshot.version).toBe(2));
    expect(request).toHaveBeenCalledOnce();
  });

  it('首次读取失败可以显式重试，已有模型在重读失败时保留', async () => {
    let calls = 0;
    const { client } = appearanceClient(async () => { calls += 1; if (calls !== 2) throw new Error('offline'); return appearanceFixture(); });
    render(<AppearanceProvider client={client} active><CharacterPanel username="camp-user" /><PublishPanelAppearance /></AppearanceProvider>);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: content.retry }));
    await screen.findByTestId('saved-character-preview');
    fireEvent.click(screen.getByRole('button', { name: '刷新外观快照' }));
    await screen.findByRole('alert');
    expect(screen.getByTestId('saved-character-preview')).toBeInTheDocument();
  });
});
