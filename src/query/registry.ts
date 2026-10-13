import { safeLabel } from './parse.ts';
import { QuotaError } from './types.ts';
import type { LimitAmounts, QuotaAdapter, QuotaSnapshot } from './types.ts';

export class AdapterRegistry {
  private readonly adapters = new Map<string, QuotaAdapter>();

  constructor(adapters: readonly QuotaAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: QuotaAdapter): void {
    if (!adapter.provider || !adapter.label || this.adapters.has(adapter.provider)) {
      throw new Error('Quota adapter must have a unique provider ID and a label');
    }
    this.adapters.set(adapter.provider, { ...adapter, label: safeLabel(adapter.label) });
  }

  get(provider: string | undefined): QuotaAdapter | undefined {
    return provider ? this.adapters.get(provider) : undefined;
  }

  list(): readonly QuotaAdapter[] {
    return [...this.adapters.values()];
  }
}

// Validate even custom/exec adapter output before it reaches a consumer.
export function validateSnapshot(snapshot: unknown): QuotaSnapshot {
  const data = record(snapshot);
  if (!Number.isFinite(data.fetchedAt)
    || ['windows', 'balance', 'allowance', 'spend'].some(key => key in data)) throw new QuotaError('schema');
  const balances = entries(data.balances).map(entry => {
    if (!isCurrency(entry.currency) || !Number.isFinite(entry.remaining)
      || entry.unlimited !== undefined) throw new QuotaError('schema');
    return { ...identity(entry), currency: entry.currency, remaining: entry.remaining as number };
  });
  const limits = entries(data.limits).map(entry => {
    if ((entry.scope !== undefined && typeof entry.scope !== 'string')
      || (entry.durationSeconds !== undefined && (!Number.isFinite(entry.durationSeconds) || (entry.durationSeconds as number) <= 0))
      || (entry.remainingPercent !== null && (!Number.isFinite(entry.remainingPercent)
        || (entry.remainingPercent as number) < 0 || (entry.remainingPercent as number) > 100))
      || (entry.resetAt !== null && (!Number.isFinite(entry.resetAt) || (entry.resetAt as number) <= 0))
      || (entry.unlimited !== undefined && entry.unlimited !== true)
      || (entry.unlimited === true && (entry.amounts !== undefined || entry.remainingPercent !== null))) {
      throw new QuotaError('schema');
    }
    return { ...identity(entry), remainingPercent: entry.remainingPercent as number | null,
      resetAt: entry.resetAt as number | null,
      ...(entry.scope !== undefined ? { scope: label(entry.scope) } : {}),
      ...(entry.durationSeconds !== undefined ? { durationSeconds: entry.durationSeconds as number } : {}),
      ...(entry.amounts !== undefined ? { amounts: validateAmounts(entry.amounts) } : {}),
      ...(entry.unlimited === true ? { unlimited: true as const } : {}) };
  });
  const spending = entries(data.spending).map(entry => {
    if (!isCurrency(entry.currency) || !Number.isFinite(entry.amount) || (entry.amount as number) < 0
      || (entry.period !== 'today' && entry.period !== 'lifetime')) throw new QuotaError('schema');
    return { ...identity(entry), currency: entry.currency, amount: entry.amount as number, period: entry.period as 'today' | 'lifetime' };
  });
  if (balances.length + limits.length + spending.length === 0) throw new QuotaError('schema');
  return { balances, limits, spending, fetchedAt: data.fetchedAt as number };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QuotaError('schema');
  return value as Record<string, unknown>;
}

function label(value: unknown): string {
  if (typeof value !== 'string') throw new QuotaError('schema');
  const clean = safeLabel(value).trim();
  if (!clean) throw new QuotaError('schema');
  return clean;
}

function identity(data: Record<string, unknown>): { id: string; label: string } {
  // IDs are opaque and preserved, never derived from duration, scope or label.
  if (typeof data.id !== 'string' || !data.id || data.id !== label(data.id) || data.id.length > 64) {
    throw new QuotaError('schema');
  }
  return { id: data.id, label: label(data.label) };
}

function entries(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 64) throw new QuotaError('schema');
  const ids = new Set<string>();
  return value.map(item => {
    const data = record(item);
    const { id } = identity(data);
    if (ids.has(id)) throw new QuotaError('schema');
    ids.add(id);
    return data;
  });
}

function isCurrency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

function validateAmounts(value: unknown): LimitAmounts {
  const data = record(value);
  if ((data.limit !== null && (!Number.isFinite(data.limit) || (data.limit as number) < 0))
    || !Number.isFinite(data.used) || (data.used as number) < 0
    || !Number.isFinite(data.remaining)) throw new QuotaError('schema');
  return { unit: label(data.unit), limit: data.limit as number | null,
    used: data.used as number, remaining: data.remaining as number };
}
