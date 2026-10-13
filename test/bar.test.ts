import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { formatPercent, horizontalBar, remainingTone, renderBar, verticalBar } from '../src/bar/bar.ts';
import { quotaElement, renderFooter, renderUsage } from '../src/bar/quota.ts';
import { aggregateCompactLines, aggregateUsageLines, captureAllUsage, usageCardComponent } from '../src/bar/card.ts';
import type { QuotaSnapshot, QuotaState, UsageLimit } from '../src/query/types.ts';

const now = Date.parse('2026-09-07T04:00:00Z');
const limit = (id: string, label: string, pct: number | null): UsageLimit => ({
  id, label, durationSeconds: 18000, remainingPercent: pct, resetAt: now + 8100000,
});
const ready = (provider: string, label: string, data: Partial<QuotaSnapshot>): Extract<QuotaState, { kind: 'ready' }> => ({
  kind: 'ready', provider, label, snapshot: { fetchedAt: now, limits: [], balances: [], spending: [], ...data },
});
const state = ready('openai-codex', 'Codex', { limits: [limit('5h', '5h', 72),
  { ...limit('weekly', '1w', 85), durationSeconds: 604800, resetAt: now + 442800000 }] });
const wallet = (remaining: number, currency = 'USD') => ({ id: 'wallet', label: 'Balance', remaining, currency });

test('exact requested footer: English, brackets, arrow spacing, no provider/remaining, trailing space', () => {
  const text = renderFooter(state, undefined, now);
  assert.equal(text, '5h [▆] 72% ↺ 2h15m · 1w [▇] 85% ↺ 5d3h ');
  assert.ok(text.endsWith(' '));
  assert.equal(text.includes('Codex'), false);
  assert.equal(text.includes('Remaining'), false);
});

test('/usage uses compact horizontal bars and provider grouping', () => {
  assert.deepEqual(renderUsage(state, undefined, now), ['Codex', '',
    '  5h  [████████████░░░░]  72% ↺ 2h15m', '  1w  [██████████████░░]  85% ↺ 5d3h']);
});

test('detail columns align for long labels, wide characters, decimals and unknown values', () => {
  const labels = ['1w', 'gpt-reserve/1w', '界/5h', 'other/1w'];
  const values = [100, 8, 99.9, null];
  const varied = ready('custom', 'Custom', { limits: labels.map((label, i) => limit(String(i), label, values[i])) });
  const lines = renderUsage(varied, undefined, now).slice(2);
  for (const marker of ['[', ']', '↺']) {
    const columns = lines.map(line => visibleWidth(line.slice(0, line.indexOf(marker))));
    assert.equal(new Set(columns).size, 1, `${marker} column must align`);
  }
  assert.ok(lines[0].includes('  100% ↺ '));
  assert.ok(lines[1].includes('    8% ↺ '));
  assert.equal(renderUsage(varied, undefined, now).length, 6);
});

test('bar and percent use colors; labels and reset times remain dim', () => {
  const calls: [string, string][] = [];
  renderFooter(state, (tone, text) => { calls.push([tone, text]); return text; }, now);
  assert.ok(calls.some(([tone, text]) => tone === 'success' && text === '[▆] 72%'));
  assert.ok(calls.some(([tone, text]) => tone === 'dim' && text === ' ↺ 2h15m'));
  assert.equal(remainingTone(30.1), 'success');
  assert.equal(remainingTone(30), 'warning');
  assert.equal(remainingTone(10), 'error');
  assert.equal(remainingTone(null), 'dim');
});

test('unknown, empty and full are distinct; rounding cannot suggest false empty/full', () => {
  assert.equal(verticalBar(null), '[?]');
  assert.equal(verticalBar(0), '[·]');
  assert.equal(verticalBar(1), '[▁]');
  assert.equal(verticalBar(100), '[█]');
  assert.notEqual(verticalBar(99.99), '[█]');
  assert.equal(formatPercent(0.01), '0.1%');
  assert.equal(formatPercent(99.99), '99.9%');
  assert.equal(formatPercent(null), '?');
  assert.equal(horizontalBar(0, 5), '[░░░░░]');
  assert.equal(horizontalBar(100, 5), '[█████]');
  assert.notEqual(horizontalBar(99.99, 5), '[█████]');
});

test('expired reset becomes unknown/due, never fabricates 100%', () => {
  const text = renderFooter(state, undefined, now + 8100001);
  assert.ok(text.includes('5h [?] ? ↺ due'));
  assert.equal(text.includes('100%'), false);
});

test('hidden/loading/error do not masquerade as measured zero', () => {
  assert.equal(renderFooter({ kind: 'hidden' }), '');
  assert.equal(renderFooter({ kind: 'loading', provider: 'a', label: 'A' }), 'Quota … ');
  assert.equal(renderFooter({ kind: 'error', provider: 'a', label: 'A', code: 'timeout' }), 'Quota ! Request timed out ');
});

test('quota composes as one element of a larger bar, independently of query implementation', () => {
  assert.equal(renderBar([
    { id: 'context', spans: [{ text: 'ctx [▃] 32%' }] }, quotaElement(state, now),
    { id: 'git', spans: [{ text: 'main' }] },
  ]), 'ctx [▃] 32% │ 5h [▆] 72% ↺ 2h15m · 1w [▇] 85% ↺ 5d3h │ main ');
});

test('footer caps shared limits; details retain scoped and additional limits', () => {
  const extra = ready('codex', 'Codex', { limits: [...state.snapshot.limits,
    { ...limit('model', '5h', 5), scope: 'GPT-X' }] });
  assert.ok(renderFooter(extra, undefined, now).endsWith(' +1 '));
  assert.ok(renderUsage(extra, undefined, now).some(line => line.startsWith('  GPT-X/5h ')));
  const three = ready('codex', 'Codex', { limits: [...state.snapshot.limits, limit('monthly', '30d', 58)] });
  assert.ok(renderFooter(three, undefined, now).endsWith(' +1 '));
  assert.ok(renderFooter(three, undefined, now, 'all').includes('30d '));
  assert.equal(renderFooter(three, undefined, now, 'all').includes('+'), false);
  assert.ok(renderFooter(three, undefined, now, 3).includes('30d '));
  assert.equal(renderFooter(three, undefined, now, 1).includes('1w '), false);
});

const mixed = [
  ready('kimi', 'Kimi', { limits: [limit('5h', '5h', 100), limit('1w', '1w', 97)] }),
  ready('opencode-go', 'OpenCode Go', { limits: [limit('5h', '5h', 100), limit('30d', '30d', 14)] }),
  ready('micu-ant', 'micu-ant', { balances: [wallet(41.12)] }),
  ready('ikun', 'ikun', { balances: [wallet(17.16, 'CNY')] }),
  ready('cctq', 'cctq', { limits: [{ id: 'key', label: 'Quota', remainingPercent: null, resetAt: null, unlimited: true }] }),
  ready('codex-for', 'codex-for', { balances: [wallet(953.52)], spending: [
    { id: 'today', label: 'Spend', amount: 64.89, currency: 'USD', period: 'today' }] }),
];

test('aggregate grid aligns bars, balance amounts and reset arrows across mixed rows', () => {
  const lines = aggregateUsageLines(mixed, undefined, now);
  for (const marker of ['[', '↺']) {
    const columns = lines.filter(line => line.includes(marker)).map(line => visibleWidth(line.slice(0, line.indexOf(marker))));
    assert.equal(new Set(columns).size, 1, `${marker} column must align`);
  }
  const moneyColumns = lines.filter(line => /[$¥]/.test(line)).map(line => visibleWidth(line.slice(0, line.search(/[$¥]/))));
  assert.equal(new Set(moneyColumns).size, 1, 'balance amounts must share one column');
  assert.ok(lines.some(line => line.includes('today $64.89')));
  assert.ok(lines.some(line => line.includes('Quota') && line.includes('∞')));
  assert.equal(lines.some(line => line.includes('$∞')), false);
});

test('aggregate grid marks the current provider with a star and keeps columns aligned', () => {
  const lines = aggregateUsageLines(mixed.slice(0, 2), undefined, now, 12, 'kimi');
  assert.ok(lines[0].startsWith('★ Kimi'), lines.join('\n'));
  assert.equal(lines.some(line => line.includes('★ OpenCode')), false);
  const columns = lines.filter(line => line.includes('[')).map(line => visibleWidth(line.slice(0, line.indexOf('['))));
  assert.equal(new Set(columns).size, 1, 'star must not break bar alignment');
  assert.equal(aggregateUsageLines(mixed, undefined, now).some(line => line.includes('★')), false);
});

test('compact layout puts providers on header lines and never grows wide', () => {
  const states = [mixed[0], ready('opencode-go', 'OpenCode Go (opencode-go-2)', { limits: [limit('30d', '30d', 14)] }), mixed[2],
    { kind: 'error' as const, provider: 'deepseek', label: 'DeepSeek', code: 'auth' as const }];
  const lines = aggregateCompactLines(states, undefined, now, 6, 'kimi');
  assert.deepEqual(lines, ['★ Kimi', '  5h   [██████] 100%  ↺ 2h15m', '  1w   [█████░]  97%  ↺ 2h15m', '',
    'OpenCode Go (opencode-go-2)', '  30d  [█░░░░░]  14%  ↺ 2h15m', '', 'micu-ant  $41.12', '', 'DeepSeek  Sign in with /login']);
  assert.ok(lines.every(line => visibleWidth(line) <= 30), lines.join('\n'));
  assert.deepEqual(aggregateCompactLines([], undefined, now), ['No quota data available. Run /usage --all for details.']);
});

test('all categories render together with multiple entries and original IDs', () => {
  const data = ready('mixed', 'Mixed', {
    limits: [limit('first-5h', '5h', 72), { ...limit('second-5h', '5h', 60), scope: 'Model' },
      { id: 'requests', label: 'Requests', remainingPercent: 50.1, resetAt: null,
        amounts: { unit: 'requests', limit: 100, used: 50, remaining: 50 } },
      { id: 'tokens', label: 'Tokens', remainingPercent: null, resetAt: null,
        amounts: { unit: 'tokens', limit: null, used: 2000, remaining: 8000 } }],
    balances: [{ ...wallet(12), id: 'usd', label: 'USD wallet' }, { ...wallet(-2, 'CNY'), id: 'cny', label: 'CNY wallet' }],
    spending: [
      { id: 'one', label: 'One', currency: 'USD', amount: 2, period: 'today' },
      { id: 'two', label: 'Two', currency: 'CNY', amount: 3, period: 'today' },
      { id: 'life', label: 'Lifetime', currency: 'USD', amount: 999, period: 'lifetime' }],
  });
  for (const text of [renderUsage(data, undefined, now).join('\n'), aggregateUsageLines([data], undefined, now).join('\n'),
    aggregateCompactLines([data], undefined, now).join('\n')]) {
    for (const part of ['72%', 'Model/5h', '60%', '50.1%', '50 requests/100 requests', '8,000 tokens/?',
      'USD wallet', '$12.00', 'CNY wallet', '-¥2.00', 'Today One', '$2.00', 'Today Two', '¥3.00']) assert.ok(text.includes(part), `${part}\n${text}`);
    assert.equal(text.includes('999'), false, 'Lifetime must not replace Today');
    assert.equal(text.includes('$50'), false, 'request count must not be dollar money');
  }
  const footer = renderFooter(data, undefined, now, 'all');
  assert.ok(footer.includes('USD wallet $12.00 · CNY wallet -¥2.00'));
  assert.ok(footer.includes('50 requests'));
  assert.ok(footer.includes(' +1 '), 'scoped limit remains counted even when shared limits are preferred');
  assert.equal(footer.includes('Today'), false);
  const card = captureAllUsage([data], now);
  assert.deepEqual(card.version === 2 && card.states[0].kind === 'ready' && card.states[0].snapshot.limits.map(entry => entry.id),
    ['first-5h', 'second-5h', 'requests', 'tokens']);
  const restored = JSON.parse(JSON.stringify(card));
  assert.deepEqual(usageCardComponent(restored).render(200), usageCardComponent(card).render(200));
  for (const width of [1, 30, 80]) assert.ok(usageCardComponent(card).render(width).every(line => visibleWidth(line) <= width));
});

test('spend-only renders Today without fake balance/quota or displaying Lifetime', () => {
  const data = ready('spend', 'Spend', { spending: [
    { id: 'today', label: 'Account spend', currency: 'USD', amount: 2.5, period: 'today' },
    { id: 'lifetime', label: 'Account spend', currency: 'USD', amount: 999, period: 'lifetime' }] });
  assert.equal(renderFooter(data), '');
  assert.deepEqual(renderUsage(data), ['Spend', '', '  Today     $2.50']);
  for (const render of [aggregateUsageLines, aggregateCompactLines]) {
    const text = render([data], undefined, now).join('\n');
    assert.ok(text.includes('Today') && text.includes('$2.50'), text);
    assert.equal(text.includes('999'), false);
    assert.equal(/[↺%█]/u.test(text), false);
  }
});
