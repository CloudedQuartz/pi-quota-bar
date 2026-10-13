import { visibleWidth } from '@earendil-works/pi-tui';
import { duration, formatPercent, horizontalBar, plain, remainingTone, renderBar, verticalBar } from './bar.ts';
import type { BarElement, Paint, Span } from './bar.ts';
import { amountSummary, balanceSpans, money, quantity } from './balance.ts';
import type { QuotaErrorCode, QuotaState, UsageLimit } from '../query/types.ts';
import type { FooterWindows } from '../query/settings.ts';

const errorText: Record<QuotaErrorCode, string> = {
  auth: 'Sign in with /login',
  'unsupported-auth': 'Unsupported credentials or endpoint',
  'account-access': 'Account quota access denied',
  network: 'Network error', timeout: 'Request timed out',
  'rate-limit': 'Rate limited', http: 'Service unavailable', schema: 'Unrecognized quota response',
};

export function limitLabel(limit: UsageLimit): string {
  return `${limit.scope ? `${limit.scope}/` : ''}${limit.label}`;
}

export function limitRemaining(limit: UsageLimit, now: number): number | null {
  // Reaching the reset deadline is not proof the provider granted a fresh quota.
  return limit.resetAt !== null && limit.resetAt <= now ? null : limit.remainingPercent;
}

export function limitReset(limit: UsageLimit, now: number): string {
  // No schedule is inferred from duration alone. No duration/reset means unknown.
  return limit.resetAt !== null ? `↺ ${duration(limit.resetAt - now)}`
    : limit.durationSeconds !== undefined ? '↺ ?' : '';
}

function limitSpans(limit: UsageLimit, now: number): Span[] {
  const remaining = limitRemaining(limit, now);
  const value = limit.unlimited ? '∞' : `${verticalBar(remaining)} ${limit.amounts && limit.durationSeconds === undefined
    ? quantity(limit.amounts.remaining, limit.amounts.unit) : formatPercent(remaining)}`;
  const reset = limitReset(limit, now);
  return [
    { text: `${limitLabel(limit)} `, tone: 'dim' },
    { text: value, tone: limit.unlimited ? 'text' : remainingTone(remaining) },
    ...(reset ? [{ text: ` ${reset}`, tone: 'dim' as const }] : []),
  ];
}

// Retain the existing setting name; it now caps displayed limits, not wallets.
export type { FooterWindows };

export function quotaElement(state: QuotaState, now = Date.now(), maxWindows: FooterWindows = 2): BarElement {
  const element: BarElement = { id: 'quota', spans: [] };
  if (state.kind === 'hidden') return element;
  if (state.kind === 'loading') return { ...element, spans: [{ text: 'Quota …', tone: 'dim' }] };
  if (state.kind === 'error') return { ...element, spans: [{ text: `Quota ! ${errorText[state.code]}`, tone: 'warning' }] };
  const { balances, limits } = state.snapshot;
  const shared = limits.filter(limit => !limit.scope);
  const eligible = shared.length ? shared : limits;
  const shown = maxWindows === 'all' ? eligible : eligible.slice(0, maxWindows);
  const spans: Span[] = [];
  const append = (parts: Span[]) => {
    if (spans.length) spans.push({ text: ' · ', tone: 'dim' });
    spans.push(...parts);
  };
  balances.forEach(balance => append(balanceSpans(balance, balances.length > 1)));
  shown.forEach(limit => append(limitSpans(limit, now)));
  if (limits.length > shown.length) spans.push({ text: ` +${limits.length - shown.length}`, tone: 'dim' });
  return { ...element, spans };
}

export function renderFooter(state: QuotaState, paint: Paint = plain, now = Date.now(), maxWindows: FooterWindows = 2): string {
  return renderBar([quotaElement(state, now, maxWindows)], paint);
}

export function renderUsage(state: QuotaState, paint: Paint = plain, now = Date.now(), barWidth = 16): string[] {
  if (state.kind === 'hidden') return ['No quota adapter for the current provider.'];
  const title = state.label;
  const indent = (line: string) => line ? `  ${line}` : line;
  if (state.kind === 'loading') return [title, '', indent('Loading…')];
  if (state.kind === 'error') return [title, '', indent(errorText[state.code])];
  const { limits, balances, spending } = state.snapshot;
  const labelWidth = Math.max(0, ...limits.map(limit => visibleWidth(limitLabel(limit))));
  const valueWidth = Math.max(4, ...limits.map(limit => visibleWidth(formatPercent(limitRemaining(limit, now)))));
  const lines = [title, '', ...limits.map(limit => {
    const remaining = limitRemaining(limit, now);
    const value = formatPercent(remaining);
    const reset = limitReset(limit, now);
    return indent(paint('dim', `${limitLabel(limit)}${' '.repeat(labelWidth - visibleWidth(limitLabel(limit)))}  `)
      + paint(limit.unlimited ? 'text' : remainingTone(remaining), limit.unlimited ? '∞'
        : `${horizontalBar(remaining, barWidth)} ${' '.repeat(valueWidth - visibleWidth(value))}${value}`)
      + paint('dim', `${reset ? ` ${reset}` : ''}${limit.amounts ? ` · ${amountSummary(limit.amounts)}` : ''}`));
  })];
  if (balances.length) {
    if (limits.length) lines.push('');
    balances.forEach(balance => lines.push(indent(paint('dim', `${balance.label}   `)
      + paint(balance.remaining <= 0 ? 'error' : 'text', money(balance.remaining, balance.currency)))));
  }
  const today = spending.filter(entry => entry.period === 'today');
  if (today.length) {
    if (limits.length || balances.length) lines.push('');
    today.forEach(entry => lines.push(indent(paint('dim', `Today${today.length > 1 ? ` ${entry.label}` : ''}     ${money(entry.amount, entry.currency)}`))));
  }
  return lines;
}
