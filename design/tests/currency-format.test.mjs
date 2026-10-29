import test from 'node:test';
import assert from 'node:assert/strict';
import { copy as c } from '../config/content.mjs';
import { currencyLabel, rewards } from '../src/ui-format.mjs';

// 币种文字仅供读屏，视觉上由现有图标区分。
test('币种标签使用图标，输入标签的完整名称只供读屏', () => {
  for (const [currency, label] of [['coin', c.coinReward], ['gem', c.gemPrice]]) {
    const html = currencyLabel(currency, label);
    assert.match(html, /<svg[^>]*aria-hidden="true"/);
    assert.ok(html.includes(`<span class="sr-only">${label}</span>`));
    assert.doesNotMatch(html.replace(/<span class="sr-only">.*?<\/span>/g, ''), /金币|钻石/);
  }
});

test('奖励保留零值、负余额和正奖励符号，币种名不参与可见金额', () => {
  for (const [coins, gems, plus] of [[0, 0, false], [-5, -2, false], [10, 3, true]]) {
    const html = rewards(coins, gems, plus);
    assert.ok(html.includes(`<span>${plus ? '+' : ''}${coins}</span>`));
    assert.ok(html.includes(`<span>${plus ? '+' : ''}${gems}</span>`));
    assert.doesNotMatch(html.replace(/<span class="sr-only">.*?<\/span>/g, ''), /金币|钻石/);
    assert.equal((html.match(/<svg/g) || []).length, 2);
  }
});
