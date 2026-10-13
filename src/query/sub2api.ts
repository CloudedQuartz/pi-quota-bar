import { bearer } from './http.ts';
import { numeric, object, percent, timestamp } from './parse.ts';
import { QuotaError } from './types.ts';
import { safeBaseUrl } from './url.ts';
import type { Balance, LimitAmounts, QuotaAdapter, QuotaSnapshot, UsageLimit, ProviderAuth, Spending } from './types.ts';

export function sub2ApiUsageUrl(baseUrl: string | undefined): string {
  const url = safeBaseUrl(baseUrl);
  // Anthropic clients use the host root; OpenAI clients include /v1.
  const prefix = url.pathname.replace(/\/+$/, '') || '/v1';
  url.pathname = `${prefix}/usage`;
  return url.toString();
}

function currency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw new QuotaError('schema');
  return value;
}

function amount(value: unknown): number {
  const result = numeric(value);
  if (result === null || result < 0) throw new QuotaError('schema');
  return result;
}

function allowance(data: Record<string, unknown>, unit: string): LimitAmounts {
  const limit = amount(data.limit);
  if (limit === 0) throw new QuotaError('schema');
  const used = amount(data.used);
  const remaining = amount(data.remaining);
  return { unit, limit, used, remaining };
}

function spend(data: Record<string, unknown>, currency: string): Spending[] {
  return [['today', data.today], ['lifetime', data.total]].flatMap(([period, raw]) => {
    const cost = object(raw).actual_cost;
    if (cost === undefined) return [];
    return [{ id: `key-${period}`, label: 'API key spend', currency, amount: amount(cost),
      period: period as 'today' | 'lifetime' }];
  });
}

function percentFromAmounts(remaining: number, limit: number): number {
  return percent(remaining / limit * 100);
}

const RATE_WINDOWS: Record<string, number> = { '5h': 18000, '1d': 86400, '7d': 604800 };

function rateWindow(data: Record<string, unknown>): UsageLimit {
  const label = data.window;
  if (typeof label !== 'string' || !Object.hasOwn(RATE_WINDOWS, label)) throw new QuotaError('schema');
  const limits = allowance(data, 'USD');
  return { id: `rate-${label}`, label, durationSeconds: RATE_WINDOWS[label],
    remainingPercent: percentFromAmounts(limits.remaining, limits.limit!),
    resetAt: timestamp(data.reset_at), amounts: limits };
}

function subscriptionWindows(data: Record<string, unknown>): UsageLimit[] {
  const specs = [
    ['daily', '1d', 'daily_usage_usd', 'daily_limit_usd', 86400],
    ['weekly', '1w', 'weekly_usage_usd', 'weekly_limit_usd', 604800],
    ['monthly', '30d', 'monthly_usage_usd', 'monthly_limit_usd', 2592000],
  ] as const;
  return specs.flatMap(([id, label, usedKey, limitKey, durationSeconds]) => {
    if (data[limitKey] == null) return []; // Upstream sends null for an unconfigured cap.
    const limit = numeric(data[limitKey]);
    if (limit === null || limit < 0) throw new QuotaError('schema');
    if (limit === 0) return []; // No cap for this period; no percentage can be computed.
    const used = numeric(data[usedKey]);
    if (used === null || used < 0) throw new QuotaError('schema');
    const amounts: LimitAmounts = { unit: 'USD', limit, used, remaining: Math.max(0, limit - used) };
    return [{ id, label, durationSeconds, remainingPercent: percentFromAmounts(amounts.remaining, limit),
      resetAt: null, amounts }];
  });
}

export function parseSub2ApiUsage(payload: unknown): Omit<QuotaSnapshot, 'fetchedAt'> {
  const body = object(payload);
  if (body.isValid !== true || (body.mode !== 'quota_limited' && body.mode !== 'unrestricted')) {
    throw new QuotaError('schema');
  }
  // Upstream omits `unit` when a key has rate limits but no total quota.
  // Sub2API rate limits are always USD; a fixed quota carries its own unit.
  const unit = currency(body.unit ?? (body.mode === 'quota_limited'
    ? object(body.quota).unit ?? 'USD' : undefined));
  const limits: UsageLimit[] = [];
  const balances: Balance[] = [];
  if (body.mode === 'quota_limited') {
    if (body.quota !== undefined) {
      const amounts = allowance(object(body.quota), unit);
      limits.push({ id: 'key-quota', label: 'Key quota', resetAt: null,
        remainingPercent: percentFromAmounts(amounts.remaining, amounts.limit!), amounts });
    }
    const rates = body.rate_limits;
    if (rates !== undefined) {
      if (!Array.isArray(rates)) throw new QuotaError('schema');
      rates.forEach(entry => limits.push(rateWindow(object(entry))));
    }
  } else if (body.subscription !== undefined) {
    limits.push(...subscriptionWindows(object(body.subscription)));
  } else if (body.remaining !== undefined || body.balance !== undefined) {
    const remaining = numeric(body.remaining ?? body.balance);
    if (remaining === null) throw new QuotaError('schema');
    balances.push({ id: 'wallet', label: 'Balance', currency: unit, remaining });
  }
  const spending = spend(object(body.usage), unit);
  if (limits.length + balances.length + spending.length === 0) throw new QuotaError('schema');
  return { limits, balances, spending };
}

export function createSub2ApiAdapter(provider: string): QuotaAdapter {
  return {
    provider, label: provider,
    async query(context) {
      let auth: ProviderAuth | undefined;
      try { auth = await context.getAuth(context.provider); } catch { throw new QuotaError('auth'); }
      context.signal.throwIfAborted();
      if (!auth) throw new QuotaError('auth');
      const payload = await context.getJson(sub2ApiUsageUrl(auth.baseUrl),
        { Authorization: `Bearer ${bearer(auth)}` }, context.signal);
      return { ...parseSub2ApiUsage(payload), fetchedAt: context.now() };
    },
  };
}
