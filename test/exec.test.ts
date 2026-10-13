import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecAdapter } from '../src/query/exec.ts';
import { validateSnapshot } from '../src/query/registry.ts';
import { parseQuotaConfig, QuotaConfigError } from '../src/config.ts';
import { QuotaError } from '../src/query/types.ts';
import type { QueryContext } from '../src/query/types.ts';

const now = Date.parse('2026-10-11T04:00:00Z');
const context = (overrides: Partial<QueryContext> = {}): QueryContext => ({
  provider: 'my-script', signal: new AbortController().signal, now: () => now,
  getAuth: async () => undefined,
  getJson: async () => { throw new Error('unexpected GET'); },
  postJson: async () => { throw new Error('unexpected POST'); }, ...overrides,
});

test('settings accept an exec adapter with command and label', () => {
  const config = parseQuotaConfig({ providers: { 'my-script': { adapter: 'exec', command: ['quota-cli', '--json'], label: 'My Script' } } });
  assert.deepEqual(config.providers['my-script'], { adapter: 'exec', command: ['quota-cli', '--json'], label: 'My Script' });
});

test('exec adapter rejects bad options and unknown keys', () => {
  for (const item of [
    { adapter: 'exec', label: 'x' },                          // command missing
    { adapter: 'exec', command: [], label: 'x' },             // empty argv
    { adapter: 'exec', command: ['ok'], label: '  ' },        // blank label
    { adapter: 'exec', command: ['ok', 5], label: 'x' },      // non-string arg
    { adapter: 'exec', command: ['ok'], label: 'x', env: {} }, // unknown key
  ]) {
    assert.throws(() => parseQuotaConfig({ providers: { p: item } }), QuotaConfigError);
  }
});

test('exec query runs the command, stamps fetchedAt, and passes snapshot validation', async () => {
  const adapter = createExecAdapter('my-script', {
    command: [process.execPath, '-e',
      'process.stdout.write(JSON.stringify({ fetchedAt: 1, limits: [{ id: "d", label: "Daily", remainingPercent: 42, resetAt: null, durationSeconds: 86400 }], balances: [{ id: "wallet", label: "Balance", currency: "USD", remaining: 3.5 }], spending: [] }))'],
    label: 'My Script',
  });
  const snapshot = await adapter.query(context());
  assert.equal(snapshot.fetchedAt, now); // the command's own clock is never trusted
  assert.equal(snapshot.limits[0]?.remainingPercent, 42);
  assert.equal(snapshot.balances[0]?.remaining, 3.5);
  assert.doesNotThrow(() => validateSnapshot(snapshot));
});

test('non-zero exit maps to network error without leaking output', async () => {
  const adapter = createExecAdapter('my-script', { command: [process.execPath, '-e', 'process.exit(2)'], label: 'x' });
  await assert.rejects(() => adapter.query(context()),
    (error) => error instanceof QuotaError && error.code === 'network');
});

test('unparseable or non-object output maps to schema error', async () => {
  for (const js of ['process.stdout.write("not json")', 'process.stdout.write(JSON.stringify([1,2]))']) {
    const adapter = createExecAdapter('my-script', { command: [process.execPath, '-e', js], label: 'x' });
    await assert.rejects(() => adapter.query(context()),
      (error) => error instanceof QuotaError && error.code === 'schema');
  }
});

test('output over the size bound maps to schema error', async () => {
  const adapter = createExecAdapter('my-script', { command: [process.execPath, '-e', 'process.stdout.write("x".repeat(300000))'], label: 'x' });
  await assert.rejects(() => adapter.query(context()),
    (error) => error instanceof QuotaError && error.code === 'schema');
});

test('missing command maps to network error', async () => {
  const adapter = createExecAdapter('my-script', { command: ['definitely-not-a-real-command-xyz'], label: 'x' });
  await assert.rejects(() => adapter.query(context()),
    (error) => error instanceof QuotaError && error.code === 'network');
});

test('abort kills the child and rejects with the abort reason', async () => {
  const controller = new AbortController();
  const adapter = createExecAdapter('my-script', { command: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], label: 'x' });
  const pending = adapter.query(context({ signal: controller.signal }));
  controller.abort(new QuotaError('timeout'));
  await assert.rejects(pending, (error) => error instanceof QuotaError && error.code === 'timeout');
});
