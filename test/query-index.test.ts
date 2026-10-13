import assert from 'node:assert/strict';
import test from 'node:test';
import * as query from '../src/query/index.ts';

test('query barrel exposes the standalone surface', () => {
  for (const name of [
    'AdapterRegistry', 'QuotaController', 'validateSnapshot',
    'createJsonClient', 'createPostJsonClient', 'officialAuth', 'bearer', 'header',
    'createAliasAdapter', 'createDanglingAliasAdapter',
    'createExecAdapter', 'validateExecOptions',
    'codexAdapter', 'kimiAdapter', 'openCodeGoAdapter', 'createOpenCodeGoAdapter',
    'createDeepSeekAdapter', 'createNewApiAdapter', 'validateNewApiOptions',
    'createSub2ApiAdapter', 'createYesCodeAdapter', 'validateYesCodeOptions',
    'QuotaError',
  ]) {
    assert.ok((query as Record<string, unknown>)[name] !== undefined, `missing export: ${name}`);
  }
});

test('barrel adapters satisfy the registry contract', () => {
  const registry = new query.AdapterRegistry([query.codexAdapter, query.kimiAdapter]);
  assert.equal(registry.get('openai-codex')?.provider, 'openai-codex');
  assert.equal(registry.list().length, 2);
});

test('composeQuotaRegistry wires built-ins, settings adapters and one-hop aliases', () => {
  const { registry, aliases } = query.composeQuotaRegistry({
    settings: {
      quotaUsage: {
        providers: {
          'my-ds': { adapter: 'deepseek' },
          'ds-alias': { adapter: 'alias', of: 'my-ds' },
          'bad-alias': { adapter: 'alias', of: 'nowhere' },
        },
      },
    },
  });
  for (const provider of ['openai-codex', 'kimi-coding', 'opencode-go', 'deepseek', 'my-ds', 'ds-alias', 'bad-alias']) {
    assert.ok(registry.get(provider), `missing provider: ${provider}`);
  }
  assert.deepEqual(aliases, { 'ds-alias': 'my-ds', 'bad-alias': 'nowhere' });
  // A configured alias target delegates its query to the target adapter.
  assert.equal(registry.get('ds-alias')?.label, registry.get('my-ds')?.label);
});

test('composeQuotaRegistry without settings yields the built-in set', () => {
  const { registry, aliases, footerWindows } = query.composeQuotaRegistry();
  assert.deepEqual(registry.list().map(adapter => adapter.provider),
    ['openai-codex', 'kimi-coding', 'opencode-go', 'deepseek']);
  assert.deepEqual(aliases, {});
  assert.equal(footerWindows, undefined);
});
