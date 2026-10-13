import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAliasAdapter, createDanglingAliasAdapter } from '../src/query/alias.ts';
import { loadQuotaAdaptersFromSettings, loadQuotaAliasesFromSettings, parseQuotaConfig, QuotaConfigError } from '../src/config.ts';
import { QuotaError } from '../src/query/types.ts';
import type { QueryContext, QuotaAdapter } from '../src/query/types.ts';

test('settings accept an alias binding; aliases declare no adapter of their own', () => {
  const settings = { quotaUsage: { providers: {
    main: { adapter: 'sub2api' },
    'main-alias': { adapter: 'alias', of: 'main' },
  } } };
  assert.deepEqual(parseQuotaConfig(settings.quotaUsage).providers['main-alias'], { adapter: 'alias', of: 'main' });
  assert.deepEqual({ ...loadQuotaAliasesFromSettings(settings) }, { 'main-alias': 'main' });
  assert.deepEqual(loadQuotaAdaptersFromSettings(settings).map(adapter => adapter.provider), ['main']);
});

test('alias binding rejects bad targets and unknown keys', () => {
  for (const item of [
    { adapter: 'alias' },                       // of missing
    { adapter: 'alias', of: 42 },               // of not a string
    { adapter: 'alias', of: 'p', extra: 1 },    // unknown key
  ]) {
    assert.throws(() => parseQuotaConfig({ providers: { p: item } }), QuotaConfigError);
  }
  assert.throws(() => parseQuotaConfig({ providers: { p: { adapter: 'alias', of: 'p' } } }), QuotaConfigError); // self-alias
});

test('alias adapter queries the target under the target identity', async () => {
  let seenProvider = '';
  const target: QuotaAdapter = {
    provider: 'main', label: 'Main',
    async query(context) {
      seenProvider = context.provider;
      return { limits: [], balances: [{ id: 'wallet', label: 'Balance', currency: 'USD', remaining: 1 }], spending: [], fetchedAt: context.now() };
    },
  };
  const alias = createAliasAdapter('main-alias', target);
  assert.equal(alias.provider, 'main-alias');
  assert.equal(alias.label, 'Main');
  const context: QueryContext = {
    provider: 'main-alias', signal: new AbortController().signal, now: () => 1,
    getAuth: async () => undefined,
    getJson: async () => ({}),
    postJson: async () => { throw new Error('unused'); },
  };
  const snapshot = await alias.query(context);
  assert.equal(seenProvider, 'main');
  assert.equal(snapshot.balances[0].remaining, 1);
});

test('dangling alias fails visibly instead of vanishing', async () => {
  const alias = createDanglingAliasAdapter('ghost');
  assert.equal(alias.label, 'ghost');
  await assert.rejects(() => alias.query({} as QueryContext),
    (error) => error instanceof QuotaError && error.code === 'unsupported-auth');
});
