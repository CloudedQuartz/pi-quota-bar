import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexAccountId, codexAdapter, parseCodex } from '../src/query/codex.ts';
import { kimiAdapter, parseKimi } from '../src/query/kimi.ts';
import { createOpenCodeGoAdapter, openCodeGoAdapter, parseOpenCodeGo } from '../src/query/opencode-go.ts';
import { createJsonClient } from '../src/query/http.ts';
import { AdapterRegistry, validateSnapshot } from '../src/query/registry.ts';
import { QuotaError } from '../src/query/types.ts';
import type { QueryContext } from '../src/query/types.ts';

const now = Date.parse('2026-09-07T04:00:00Z');
const jwt = (id: string) => `header.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: id },
})).toString('base64url')}.signature`;
const codexPayload = { rate_limit: {
  primary_window: { used_percent: 28, limit_window_seconds: 18000, reset_at: now / 1000 + 8100 },
  secondary_window: { used_percent: 15, limit_window_seconds: 604800, reset_after_seconds: 442800 },
} };
const kimiPayload = {
  usage: { limit: '100', used: '15', resetTime: new Date(now + 442800000).toISOString() },
  limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { limit: '100', remaining: '72', resetTime: new Date(now + 8100000).toISOString() } }],
};
const openCodeGoPayload = { usage: {
  rolling: { status: 'ok', percent: 10, resetsAt: '2026-09-22T18:52:04.287Z' },
  weekly: { status: 'ok', percent: 4, resetsAt: '2026-09-28T00:00:00.000Z' },
  monthly: { status: 'ok', percent: 2, resetsAt: '2026-10-22T13:32:00.000Z' },
} };
const context = (overrides: Partial<QueryContext> = {}): QueryContext => ({
  provider: 'kimi-coding', signal: new AbortController().signal, now: () => now,
  getAuth: async () => ({ apiKey: 'secret' }), getJson: async () => kimiPayload,
  postJson: async () => { throw new Error('unexpected POST'); },
  ...overrides,
});

test('Codex parses shared windows, timestamp units and model domains independently', () => {
  const windows = parseCodex({ ...codexPayload, additional_rate_limits: [{
    limit_name: 'GPT-X', rate_limit: { primary_window: {
      remaining_percent: 40, limit_window_seconds: 3600, reset_time_ms: now + 100000,
    } },
  }] }, now);
  assert.deepEqual(windows.map(w => [w.label, w.remainingPercent]), [['5h', 72], ['1w', 85], ['1h', 40]]);
  assert.equal(windows[0].resetAt, now + 8100000);
  assert.equal(windows[1].resetAt, now + 442800000);
  assert.equal(windows[2].scope, 'GPT-X');
  assert.equal(windows[2].resetAt, now + 100000);
});

test('Codex absent percentages are unknown, malformed payloads do not imply 100%', () => {
  assert.equal(parseCodex({ rate_limit: { primary_window: {} } }, now)[0].remainingPercent, null);
  for (const payload of [null, {}, { error: 'denied' }, { credits: { balance: 99 } }]) {
    assert.throws(() => parseCodex(payload, now), QuotaError);
  }
  assert.equal(parseCodex({ rate_limit: { primary_window: { used_percent: 150 } } }, now)[0].remainingPercent, 0);
});

test('Kimi supports string counts, remaining-only counts, all durations and sort order', () => {
  const windows = parseKimi({ ...kimiPayload, limits: [...kimiPayload.limits,
    { window: { duration: '1', timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 50, used: 50 } },
  ] });
  assert.deepEqual(windows.map(w => [w.label, w.remainingPercent]), [['1h', 0], ['5h', 72], ['1w', 85]]);
  assert.equal(windows[1].resetAt, now + 8100000);
});

test('Kimi missing or invalid counts and reset timestamps stay unknown', () => {
  for (const usage of [{ limit: 100 }, { limit: 0, used: 0 }, { limit: true, used: 0 },
    { limit: 100, used: '' }, { limit: 100, used: null }, { limit: 100, used: -1 }]) {
    const window = parseKimi({ usage })[0];
    assert.equal(window.remainingPercent, null);
    assert.equal(window.resetAt, null);
  }
  assert.equal(parseKimi({ usage: { limit: 100, used: 0 } })[0].remainingPercent, 100);
  assert.throws(() => parseKimi({}), QuotaError);
});

test('OpenCode Go maps used percent into the three fixed windows', () => {
  const windows = parseOpenCodeGo(openCodeGoPayload);
  assert.deepEqual(windows.map(w => [w.id, w.label, w.remainingPercent]), [
    ['rolling', '5h', 90], ['weekly', '1w', 96], ['monthly', '30d', 98],
  ]);
  assert.deepEqual(windows.map(w => w.durationSeconds), [18000, 604800, 2592000]);
  assert.equal(windows[0].resetAt, Date.parse('2026-09-22T18:52:04.287Z'));
});

test('OpenCode Go reads only its own field names: no aliases, no unknown windows', () => {
  // A single official deployment means no alias guessing; unknown keys are ignored.
  const windows = parseOpenCodeGo({ usage: {
    rolling: { status: 'ok', usagePercent: 50, resetAt: '2026-09-22T18:52:04.287Z' },
    hourly: { percent: 5, resetsAt: '2026-09-22T18:52:04.287Z' },
  } });
  assert.deepEqual(windows, [{ id: 'rolling', label: '5h', durationSeconds: 18000,
    remainingPercent: null, resetAt: null }]);
});

test('OpenCode Go keeps missing percentages unknown and clamps outliers', () => {
  const windows = parseOpenCodeGo({ usage: {
    rolling: { status: 'error' }, weekly: { percent: 150 }, monthly: { percent: -10 },
  } });
  assert.deepEqual(windows.map(w => w.remainingPercent), [null, 0, 100]);
  assert.equal(parseOpenCodeGo({ usage: { rolling: { percent: '25' } } })[0].remainingPercent, 75);
  for (const payload of [null, {}, { usage: {} }, { usage: { hourly: { percent: 1 } } }, { error: 'denied' }]) {
    assert.throws(() => parseOpenCodeGo(payload), QuotaError);
  }
});

test('OpenCode Go uses the official usage endpoint and rejects other origins', async () => {
  const result = await openCodeGoAdapter.query(context({ provider: 'opencode-go',
    getAuth: async provider => {
      assert.equal(provider, 'opencode-go');
      return { apiKey: 'oc-secret', baseUrl: 'https://opencode.ai/zen/go/v1' };
    },
    getJson: async (url, headers) => {
      assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
      assert.equal(headers.Authorization, 'Bearer oc-secret');
      return openCodeGoPayload;
    },
  }));
  assert.deepEqual(result.limits.map(w => w.label), ['5h', '1w', '30d']);
  assert.equal(result.fetchedAt, now);
  const getJson = async () => { assert.fail('Must not send credentials'); };
  for (const auth of [undefined, { apiKey: 'secret', baseUrl: 'https://proxy.invalid' }]) {
    await assert.rejects(openCodeGoAdapter.query(context({ provider: 'opencode-go',
      getAuth: async () => auth, getJson })), QuotaError);
  }
});

test('OpenCode Go factory binds extra accounts to their own provider ID', async () => {
  const adapter = createOpenCodeGoAdapter('opencode-go-2');
  assert.equal(adapter.provider, 'opencode-go-2');
  assert.equal(adapter.label, 'OpenCode Go (opencode-go-2)');
  assert.equal(openCodeGoAdapter.label, 'OpenCode Go'); // built-in keeps the short label
  const result = await adapter.query(context({ provider: 'opencode-go-2',
    getAuth: async provider => {
      assert.equal(provider, 'opencode-go-2');
      return { apiKey: 'oc-second' };
    },
    getJson: async (url, headers) => {
      assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
      assert.equal(headers.Authorization, 'Bearer oc-second');
      return openCodeGoPayload;
    },
  }));
  assert.deepEqual(result.limits.map(w => w.label), ['5h', '1w', '30d']);
});

test('Codex account is derived from the same runtime token, not another auth file', async () => {
  assert.equal(codexAccountId(jwt('account-A')), 'account-A');
  assert.equal(codexAccountId('sk-api-key'), undefined);
  let requested = false;
  await codexAdapter.query(context({ provider: 'openai-codex',
    getAuth: async () => ({ apiKey: jwt('account-A') }),
    getJson: async (url, headers) => {
      requested = true;
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(headers['ChatGPT-Account-Id'], 'account-A');
      return codexPayload;
    },
  }));
  assert.equal(requested, true);
});

test('runtime Authorization and account headers take precedence', async () => {
  await codexAdapter.query(context({ provider: 'openai-codex', getAuth: async () => ({
    apiKey: jwt('old'), headers: { authorization: `Bearer ${jwt('new')}`, 'chatgpt-account-id': 'selected' },
  }), getJson: async (_url, headers) => {
    assert.equal(headers.Authorization, `Bearer ${jwt('new')}`);
    assert.equal(headers['ChatGPT-Account-Id'], 'selected');
    return codexPayload;
  } }));
});

test('Kimi uses the official endpoint and its own resolved credentials', async () => {
  const result = await kimiAdapter.query(context({ getAuth: async provider => {
    assert.equal(provider, 'kimi-coding');
    return { apiKey: 'kimi-secret', baseUrl: 'https://api.kimi.com/coding' };
  }, getJson: async (url, headers) => {
    assert.equal(url, 'https://api.kimi.com/coding/v1/usages');
    assert.equal(headers.Authorization, 'Bearer kimi-secret');
    return kimiPayload;
  } }));
  assert.equal(result.fetchedAt, now);
});

test('custom origins, missing auth and non-Codex API keys fail before HTTP', async () => {
  const getJson = async () => { assert.fail('Must not send credentials'); };
  for (const auth of [undefined, { apiKey: 'secret', baseUrl: 'https://proxy.invalid' },
    { apiKey: 'secret', baseUrl: 'https://user@api.kimi.com/coding' }]) {
    await assert.rejects(kimiAdapter.query(context({ getAuth: async () => auth, getJson })), QuotaError);
  }
  await assert.rejects(codexAdapter.query(context({ provider: 'openai-codex', getJson })), QuotaError);
});

test('HTTP requests are GET-only, abort-aware and do not follow redirects', async () => {
  const signal = new AbortController().signal;
  const client = createJsonClient((async (_url, init) => {
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.signal, signal);
    return new Response('{"ok":true}');
  }) as typeof fetch);
  assert.deepEqual(await client('https://example.test', {}, signal), { ok: true });
});

test('HTTP errors redact response bodies, support Retry-After, and reject oversized JSON', async () => {
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limit'], [500, 'http']] as const) {
    const client = createJsonClient((async () => new Response('SECRET-BODY', {
      status, headers: { 'retry-after': '120' },
    })) as typeof fetch);
    await assert.rejects(client('https://example.test', {}, new AbortController().signal), error => {
      assert.ok(error instanceof QuotaError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes('SECRET'), false);
      if (status === 429) assert.equal(error.retryAfterMs, 120000);
      return true;
    });
  }
  for (const body of ['<html>secret</html>', 'x'.repeat(300000)]) {
    const client = createJsonClient((async () => new Response(body)) as typeof fetch);
    await assert.rejects(client('https://example.test', {}, new AbortController().signal), QuotaError);
  }
});

test('custom adapters register explicitly; output is validated and labels sanitized', () => {
  const adapter = { provider: 'custom', label: 'Custom', query: async () => ({ balances: [], limits: [], spending: [], fetchedAt: now }) };
  const registry = new AdapterRegistry([adapter]);
  assert.equal(registry.get('custom')?.provider, 'custom');
  assert.equal(registry.get('unregistered'), undefined);
  assert.throws(() => registry.register(adapter));
  const snapshot = { fetchedAt: now, balances: [], limits: [], spending: [] };
  assert.throws(() => validateSnapshot(snapshot), QuotaError);
  const limit = parseKimi(kimiPayload)[0];
  assert.throws(() => validateSnapshot({ ...snapshot, limits: [{ ...limit, remainingPercent: NaN }] }), QuotaError);
  assert.throws(() => validateSnapshot({ ...snapshot, limits: [limit, limit] }), QuotaError);
  assert.equal(validateSnapshot({ ...snapshot, limits: [{ ...limit, label: '5h\n\x1b' }] }).limits[0].label, '5h');
});

test('snapshot contract: legacy fields rejected, unknown is not zero, categories stay independent', () => {
  const wallet = { id: 'wallet', label: 'Balance', currency: 'USD', remaining: -4.2 };
  const requestLimit = { id: 'requests', label: 'Requests', remainingPercent: 80, resetAt: null,
    amounts: { unit: 'requests', limit: null, used: 20, remaining: 80 } };
  const spend = { id: 'today', label: 'Reported spend', currency: 'USD', amount: 2.5, period: 'today' };
  const base = { fetchedAt: now, balances: [wallet], limits: [requestLimit], spending: [spend] };
  assert.deepEqual(validateSnapshot(base), base); // missing cap stays null, count units stay counts

  // Legacy top-level fields are rejected, never converted — even beside a valid snapshot.
  for (const legacy of [{ windows: [] }, { balance: wallet }, { allowance: requestLimit }, { spend }]) {
    assert.throws(() => validateSnapshot({ ...base, ...legacy }), QuotaError);
  }
  // Spend-only is valid; every array is required and all-empty is not a snapshot.
  assert.deepEqual(validateSnapshot({ fetchedAt: now, balances: [], limits: [], spending: [spend] }),
    { fetchedAt: now, balances: [], limits: [], spending: [spend] });
  for (const missing of ['balances', 'limits', 'spending'] as const) {
    const partial: Record<string, unknown> = { ...base };
    delete partial[missing];
    assert.throws(() => validateSnapshot(partial), QuotaError);
  }
  // IDs are unique within a category, not across categories.
  assert.doesNotThrow(() => validateSnapshot({ ...base, limits: [{ ...requestLimit, id: 'wallet' }] }));
  assert.throws(() => validateSnapshot({ ...base, limits: [requestLimit, { ...requestLimit }] }), QuotaError);
  // An unlimited limit carries no percentage and no amounts; a wallet is never unlimited.
  const unlimited = { id: 'unlimited', label: 'Unlimited', remainingPercent: null, resetAt: null, unlimited: true };
  assert.doesNotThrow(() => validateSnapshot({ ...base, limits: [unlimited] }));
  assert.throws(() => validateSnapshot({ ...base, limits: [{ ...unlimited, remainingPercent: 100 }] }), QuotaError);
  assert.throws(() => validateSnapshot({ ...base, limits: [{ ...unlimited, amounts: requestLimit.amounts }] }), QuotaError);
  assert.throws(() => validateSnapshot({ ...base, balances: [{ ...wallet, unlimited: true }] }), QuotaError);
  // Supplied numeric fields must be usable: positive duration, known spend period.
  assert.throws(() => validateSnapshot({ ...base, limits: [{ ...requestLimit, durationSeconds: 0 }] }), QuotaError);
  assert.throws(() => validateSnapshot({ ...base, spending: [{ ...spend, period: 'week' }] }), QuotaError);
});
