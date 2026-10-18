import { bearer, header, officialAuth } from './http.ts';
import { numeric, object, percent, safeLabel, timestamp, windowLabel } from './parse.ts';
import { QuotaError } from './types.ts';
import type { QueryContext, QuotaAdapter, QuotaSnapshot, UsageLimit } from './types.ts';

// Decode only to obtain routing metadata from the same resolved token.
// This does not verify a JWT; the official server verifies authentication.
export function codexAccountId(token: string): string | undefined {
  try {
    const payload = object(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')));
    const id = object(payload['https://api.openai.com/auth']).chatgpt_account_id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch { return undefined; }
}

export function parseCodex(payload: unknown, now: number): UsageLimit[] {
  const data = object(payload);
  const windows: UsageLimit[] = [];
  const addDomain = (raw: unknown, domain: string, scope?: string) => {
    const rate = object(raw);
    for (const [key, fallback] of [['primary_window', 18000], ['secondary_window', 604800]] as const) {
      if (rate[key] == null) continue;
      const window = object(rate[key]);
      const duration = numeric(window.limit_window_seconds) ?? fallback;
      if (duration <= 0) throw new QuotaError('schema');
      const remaining = numeric(window.remaining_percent) ?? numeric(window.percent_left);
      const used = numeric(window.used_percent);
      const resetAfter = numeric(window.reset_after_seconds);
      const resetAt = timestamp(window.reset_at ?? window.reset_time_ms)
        ?? (resetAfter !== null && resetAfter >= 0 ? now + resetAfter * 1000 : null);
      windows.push({
        id: `${domain}/${key}`, label: windowLabel(duration), durationSeconds: duration,
        remainingPercent: remaining !== null ? percent(remaining) : used !== null ? percent(100 - used) : null,
        resetAt, ...(scope ? { scope } : {}),
      });
    }
  };
  addDomain(data.rate_limit, 'shared');
  if (Array.isArray(data.additional_rate_limits)) {
    for (const [index, entry] of data.additional_rate_limits.entries()) {
      const item = object(entry);
      const name = item.limit_name ?? item.metered_feature;
      const scope = typeof name === 'string' ? safeLabel(name) : `Model ${index + 1}`;
      addDomain(item.rate_limit, `additional-${index}`, scope);
    }
  }
  if (windows.length === 0) throw new QuotaError('schema');
  return windows;
}

function codexQuery(context: QueryContext): Promise<QuotaSnapshot> {
  const auth = officialAuth(context, 'https://chatgpt.com');
  return auth.then(resolved => {
    const token = bearer(resolved);
    const account = header(resolved, 'chatgpt-account-id') ?? codexAccountId(token);
    if (!account) throw new QuotaError('unsupported-auth');
    return context.getJson('https://chatgpt.com/backend-api/wham/usage', {
      Authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': account,
      Origin: 'https://chatgpt.com', Referer: 'https://chatgpt.com/',
    }, context.signal);
  }).then(data => {
    const now = context.now();
    return { balances: [], limits: parseCodex(data, now), spending: [], fetchedAt: now };
  });
}

export const codexAdapter: QuotaAdapter = {
  provider: 'openai-codex', label: 'Codex',
  query: codexQuery,
};

// Pi's built-in `openai` provider may carry the same ChatGPT OAuth subscription
// credential under a different provider ID. It shares the Codex usage endpoint;
// an API-key credential cannot produce a ChatGPT account ID and fails cleanly.
export const openaiAdapter: QuotaAdapter = {
  provider: 'openai', label: 'OpenAI',
  query: codexQuery,
};
