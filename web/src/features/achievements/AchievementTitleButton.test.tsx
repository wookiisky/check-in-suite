import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AchievementTitleButton } from './AchievementTitleButton';
import { AchievementStrip } from './AchievementStrip';
import { achievementFixture } from './test-fixtures';
import content from './content.json';

const locked = { ...achievementFixture, id: 'locked', name: '未来成就', qualified: false };
const title = { id: achievementFixture.id, name: achievementFixture.name };

describe('选择成就文本', () => {
  it('只显示已获得文本，选择和卸下都提交绝对目标', async () => {
    const request = vi.fn().mockResolvedValueOnce({ title }).mockResolvedValueOnce({ title: null });
    const onSaved = vi.fn();
    const props = { client: { request }, items: [achievementFixture, locked], onSaved };
    const view = render(<AchievementTitleButton {...props} title={null} />);
    fireEvent.click(screen.getByRole('button', { name: content.chooseTitle }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText(locked.name)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: title.name }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(title));
    expect(request).toHaveBeenLastCalledWith('/achievements/title', { method: 'PUT', body: { achievement_id: title.id } });
    view.rerender(<AchievementTitleButton {...props} title={title} />);
    fireEvent.click(screen.getByRole('button', { name: title.name }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: content.removeTitle }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null));
    expect(request).toHaveBeenLastCalledWith('/achievements/title', { method: 'PUT', body: { achievement_id: null } });
  });

  it('写入结果未确认时先读回，更新当前文本且不重复提交', async () => {
    const request = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce({ items: [achievementFixture], title });
    const onSaved = vi.fn();
    render(<AchievementTitleButton client={{ request }} items={[achievementFixture]} title={null} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: content.chooseTitle }));
    fireEvent.click(screen.getByRole('button', { name: title.name }));
    await screen.findByRole('alert');
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: title.name })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: content.reload }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(title));
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/achievements/title', '/achievements']);
  });
});

describe('打卡页徽章', () => {
  it('展示没有手动佩戴的已获得徽章，并按账号记住折叠状态', () => {
    localStorage.clear();
    const badgeName = `${content.details} ${title.name}`;
    const renderCharacter: Parameters<typeof AchievementStrip>[0]['renderCharacter'] = (toggle) => <div data-testid="character-preview">{toggle}</div>;
    const view = render(<AchievementStrip items={[achievementFixture]} accountID={1} renderCharacter={renderCharacter} />);
    expect(screen.getByRole('button', { name: badgeName })).toBeVisible();
    const disclosure = within(screen.getByTestId('character-preview')).getByRole('button', { name: content.badgeTitle });
    const badges = screen.getByRole('region', { name: content.badgeTitle });
    expect(disclosure).toHaveAttribute('aria-controls', badges.id);
    expect(badges).not.toHaveClass('panel');
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: badgeName })).not.toBeInTheDocument();
    view.unmount();
    const reopened = render(<AchievementStrip items={[achievementFixture]} accountID={1} renderCharacter={renderCharacter} />);
    expect(screen.getByRole('button', { name: content.badgeTitle })).toHaveAttribute('aria-expanded', 'false');
    reopened.unmount();
    render(<AchievementStrip items={[achievementFixture]} accountID={2} renderCharacter={renderCharacter} />);
    expect(screen.getByRole('button', { name: badgeName })).toBeVisible();
  });
});
