import { bearer } from './http.ts';
import { numeric, object, percent } from './parse.ts';
import { QuotaError } from './types.ts';
import { safeBaseUrl } from './url.ts';
import type { QuotaAdapter, QuotaSnapshot } from './types.ts';

type Amounts = Omit<QuotaSnapshot, 'fetchedAt'>;

export interface NewApiOptions {
  quotaPerUnit?: number;
  currency?: string;
  // Console dashboard PAT (个人设置 → 安全设置 → 系统访问令牌). When set,
  // /api/user/self is queried first for the real account balance.
  dashboardAccessToken?: string;
  // Numeric user ID, sent as New-Api-User. Only old new-api forks require it.
  dashboardUserId?: number;
}

export function validateNewApiOptions(options: NewApiOptions): { quotaPerUnit: number; currency: string } {
  const quotaPerUnit = options.quotaPerUnit ?? 500000;
  const currency = options.currency ?? 'USD';
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) throw new Error('quotaPerUnit must be a positive number');
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be a three-letter uppercase code');
  return { quotaPerUnit, currency };
}

// Billing endpoints live at the deployment root, never under /v1.
// https://host/v1 -> https://host, https://host/gateway/v1 -> https://host/gateway
export function newApiRootUrl(baseUrl: string | undefined): string {
  const url = safeBaseUrl(baseUrl);
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v\d+(?:beta\d*)?$/i, '');
  return url.origin + path;
}

// GET /api/usage/token (new-api >= v0.9.0-alpha.8, PR QuantumNous/new-api#1161):
// accepts the sk- model key itself (TokenAuth), returns per-token quota in
// the same unit as /api/user/self quota. Response shell: {code:true,data:{...}}.
export function parseNewApiTokenUsage(payload: unknown, options: NewApiOptions = {}): Amounts | null {
  const { quotaPerUnit, currency } = validateNewApiOptions(options);
  const response = object(payload);
  if (response.code !== true) return null;
  const data = object(response.data);
  if (data.object !== 'token_usage') return null;
  const used = numeric(data.total_used);
  if (used === null || !Number.isSafeInteger(used) || used < 0) throw new QuotaError('schema');
  const spending = [{ id: 'key-lifetime', label: 'API key spend', currency,
    amount: used / quotaPerUnit, period: 'lifetime' as const }];
  if (data.unlimited_quota === true) {
    return { balances: [], limits: [{ id: 'key-quota', label: 'Key quota',
      remainingPercent: null, resetAt: null, unlimited: true }], spending };
  }
  const remaining = numeric(data.total_available);
  if (remaining === null || !Number.isSafeInteger(remaining)) throw new QuotaError('schema');
  const moneyLeft = remaining / quotaPerUnit;
  if (!Number.isFinite(moneyLeft)) throw new QuotaError('schema');

  // New-api reports granted = key used + key remaining. Only draw a finite
  // allocation bar when the server actually supplies that total.
  let limit: number | null = null;
  if (data.total_granted !== undefined) {
    const granted = numeric(data.total_granted);
    if (granted === null || !Number.isSafeInteger(granted) || granted < 0
      || !Number.isSafeInteger(used + remaining) || granted !== used + remaining) throw new QuotaError('schema');
    limit = granted / quotaPerUnit;
  }
  // Key quota is not owned account money. Missing total_granted stays unknown.
  return { balances: [], limits: [{ id: 'key-quota', label: 'Key quota', resetAt: null,
    remainingPercent: limit !== null && limit > 0 ? percent(moneyLeft / limit * 100) : null,
    amounts: { unit: currency, limit, used: used / quotaPerUnit, remaining: moneyLeft } }], spending };
}

// GET /api/user/self (UserAuth): the console's own account quota, readable with
// a dashboard access token (PAT), which sk- keys are not. Old forks also demand
// a matching New-Api-User header. Response shell: {success:true,data:{...}}.
export function parseNewApiUserSelf(payload: unknown, options: NewApiOptions = {}): Amounts {
  const { quotaPerUnit, currency } = validateNewApiOptions(options);
  const response = object(payload);
  if (response.success !== true) throw new QuotaError('schema');
  const data = object(response.data);
  const quota = numeric(data.quota);
  const usedQuota = numeric(data.used_quota);
  if (quota === null || usedQuota === null
    || !Number.isSafeInteger(quota) || !Number.isSafeInteger(usedQuota)
    || quota < 0 || usedQuota < 0) throw new QuotaError('schema');
  return { balances: [{ id: 'account', label: 'Balance', currency, remaining: quota / quotaPerUnit }],
    limits: [], spending: [{ id: 'account-lifetime', label: 'Account spend', currency,
      amount: usedQuota / quotaPerUnit, period: 'lifetime' }] };
}

// Legacy one-api billing pair, still the only option on older deployments.
// total_usage is in cents (divide by 100, per one-api issue #1785); most
// deployments report a fake 1e8 hard limit for unlimited quotas.
export function parseNewApiBilling(subscription: unknown, usage: unknown, options: NewApiOptions = {}): Amounts {
  const { currency } = validateNewApiOptions(options);
  const sub = object(subscription);
  const limit = numeric(sub.hard_limit_usd);
  const list = object(usage);
  const totalUsage = numeric(list.total_usage);
  if (limit === null || !Number.isFinite(limit) || limit < 0
    || totalUsage === null || !Number.isFinite(totalUsage) || totalUsage < 0) throw new QuotaError('schema');
  const used = totalUsage / 100;
  // This endpoint reports account remaining + lifetime usage as its hard limit.
  // Top-ups change that total, so it is a wallet balance, not a fixed allowance.
  const spending = [{ id: 'billing-lifetime', label: 'Reported spend', currency, amount: used, period: 'lifetime' as const }];
  if (limit >= 1e7) return { balances: [], limits: [{ id: 'billing-quota', label: 'Quota',
    remainingPercent: null, resetAt: null, unlimited: true }], spending };
  return { balances: [{ id: 'account', label: 'Balance', currency, remaining: limit - used }], limits: [], spending };
}

export function createNewApiAdapter(provider: string, options: NewApiOptions = {}): QuotaAdapter {
  const settings = validateNewApiOptions(options);
  const { dashboardAccessToken, dashboardUserId } = options;
  if (dashboardAccessToken !== undefined
    && (typeof dashboardAccessToken !== 'string' || dashboardAccessToken.trim() === '')) {
    throw new Error('dashboardAccessToken must be a non-empty string');
  }
  if (dashboardUserId !== undefined
    && (!Number.isSafeInteger(dashboardUserId) || dashboardUserId <= 0)) {
    throw new Error('dashboardUserId must be a positive integer');
  }
  return {
    provider, label: provider,
    async query(context) {
      let auth;
      try { auth = await context.getAuth(context.provider); }
      catch { throw new QuotaError('auth'); }
      context.signal.throwIfAborted();
      if (!auth) throw new QuotaError('auth');
      const root = newApiRootUrl(auth.baseUrl);
      // 0. Console account balance via PAT: the only view of real remaining
      // account quota. Any failure falls through to the key-native paths.
      if (dashboardAccessToken !== undefined) {
        const headers: Record<string, string> = { Authorization: `Bearer ${dashboardAccessToken}` };
        if (dashboardUserId !== undefined) headers['New-Api-User'] = String(dashboardUserId);
        try {
          const payload = await context.getJson(`${root}/api/user/self`, headers, context.signal);
          return { ...parseNewApiUserSelf(payload, settings), fetchedAt: context.now() };
        } catch (error) {
          if (!(error instanceof QuotaError)) throw error;
        }
      }
      const headers = { Authorization: `Bearer ${bearer(auth)}` };
      // 1. Account billing (one-api legacy): a finite hard limit is the real
      // account balance. 1e8 means unlimited — then the key quota may still
      // be finite and more precise.
      let billingBalance: Amounts | null = null;
      try {
        const pair = await Promise.all([
          context.getJson(`${root}/v1/dashboard/billing/subscription`, headers, context.signal),
          context.getJson(`${root}/v1/dashboard/billing/usage?start_date=2020-01-01&end_date=2100-01-01`, headers, context.signal),
        ]);
        const billing = parseNewApiBilling(pair[0], pair[1], settings);
        if (billing.balances.length > 0) return { ...billing, fetchedAt: context.now() };
        billingBalance = billing;
      } catch (error) {
        // 404: deployment has no billing pair. 401: try the key-native endpoint
        // below — some deployments accept sk- only there.
        if (error instanceof QuotaError && (error.code === 'http' || error.code === 'auth')) { /* fall through */ }
        else throw error;
      }
      // 2. Per-token usage (new-api ≥ v0.9.0-alpha.8): native sk- support.
      try {
        const payload = await context.getJson(`${root}/api/usage/token/`, headers, context.signal);
        const parsed = parseNewApiTokenUsage(payload, settings);
        if (parsed) return { ...parsed, fetchedAt: context.now() };
      } catch (error) {
        if (billingBalance && error instanceof QuotaError && error.code === 'http') {
          return { ...billingBalance, fetchedAt: context.now() };
        }
        if (error instanceof QuotaError && error.code === 'auth') throw new QuotaError('account-access');
        throw error;
      }
      if (billingBalance) return { ...billingBalance, fetchedAt: context.now() };
      throw new QuotaError('schema');
    },
  };
}
