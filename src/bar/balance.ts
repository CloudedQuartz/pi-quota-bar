import type { Balance, LimitAmounts } from '../query/types.ts';
import type { Span } from './bar.ts';

export function money(amount: number, currency: string): string {
  const sign = amount < 0 ? '-' : '';
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
  const absolute = Math.abs(amount);
  if (absolute > 0 && absolute < 0.01) return `${sign}<${symbol}0.01`;
  return `${sign}${symbol}${absolute.toFixed(2)}`;
}

export function quantity(amount: number, unit: string): string {
  return /^[A-Z]{3}$/.test(unit) ? money(amount, unit) : `${amount.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${unit}`;
}

export function amountSummary(amounts: LimitAmounts): string {
  return `${quantity(amounts.remaining, amounts.unit)}/${amounts.limit === null ? '?' : quantity(amounts.limit, amounts.unit)}`
    + ` · ${quantity(amounts.used, amounts.unit)} used`;
}

export function balanceSpans(balance: Balance, multiple = false): Span[] {
  return [
    { text: `${!multiple && balance.label === 'Balance' ? 'Bal' : balance.label} `, tone: 'dim' },
    { text: money(balance.remaining, balance.currency), tone: balance.remaining <= 0 ? 'error' : 'text' },
  ];
}
