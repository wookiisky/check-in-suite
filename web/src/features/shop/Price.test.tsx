import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Price } from './Price';
import { ProductEditor } from './ProductEditor';
import { product } from './test-fixtures';
import { testSession } from '../../test/account-fixtures';
import content from './content.json';

describe('价格的币种展示', () => {
  it.each([[12, 3], [0, 0], [-4, -2]])('只显示图标和准确数量：%i、%i', (coins, diamonds) => {
    const { container } = render(<Price coins={coins} diamonds={diamonds} />);
    expect(container).not.toHaveTextContent(/金币|钻石/);
    expect(screen.getByRole('img', { name: content.coins })).toHaveAttribute('src', '/api/v1/assets/coin-v1');
    expect(screen.getByRole('img', { name: content.coins }).parentElement).toHaveTextContent(String(coins));
    expect(screen.getByRole('img', { name: content.diamonds })).toHaveAttribute('src', '/api/v1/assets/gem-v1');
    expect(screen.getByRole('img', { name: content.diamonds }).parentElement).toHaveTextContent(String(diamonds));
  });

  it('商品的图标标签保留输入框名称和数值编辑', () => {
    const { container } = render(<ProductEditor client={{ request: vi.fn() }} session={{ ...testSession, timezone: 'Asia/Taipei' }} product={product} assets={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(container).not.toHaveTextContent(/金币|钻石/);
    const coins = screen.getByLabelText(content.coinPrice);
    const diamonds = screen.getByLabelText(content.diamondPrice);
    expect(coins).toHaveValue(product.coin_price);
    expect(diamonds).toHaveValue(product.diamond_price);
    fireEvent.change(coins, { target: { value: '0' } });
    fireEvent.change(diamonds, { target: { value: '7' } });
    expect(coins).toHaveValue(0);
    expect(diamonds).toHaveValue(7);
  });
});
