import { createAliasAdapter, createDanglingAliasAdapter } from './alias.ts';
import { codexAdapter } from './codex.ts';
import { createDeepSeekAdapter } from './deepseek.ts';
import { createExecAdapter, validateExecOptions } from './exec.ts';
import { kimiAdapter } from './kimi.ts';
import { createNewApiAdapter, validateNewApiOptions } from './new-api.ts';
import { createOpenCodeGoAdapter, openCodeGoAdapter } from './opencode-go.ts';
import { AdapterRegistry } from './registry.ts';
import { createSub2ApiAdapter } from './sub2api.ts';
import { createYesCodeAdapter, validateYesCodeOptions } from './yescode.ts';
import type { NewApiOptions } from './new-api.ts';
import type { YesCodeOptions } from './yescode.ts';
import type { QuotaAdapter } from './types.ts';

export type FooterWindows = number | 'all';

export type ProviderQuotaConfig =
  | ({ adapter: 'new-api'; quotaPerUnit: number; currency: string } & Pick<NewApiOptions, 'dashboardAccessToken' | 'dashboardUserId'>)
  | ({ adapter: 'yescode' } & YesCodeOptions)
  | { adapter: 'exec'; command: string[]; label: string }
  | { adapter: 'alias'; of: string }
  | { adapter: 'deepseek' | 'sub2api' | 'opencode-go' };
export interface QuotaConfig { providers: Record<string, ProviderQuotaConfig>; footerWindows?: FooterWindows }

const DASHBOARD_KEYS = ['dashboardAccessToken', 'dashboardUserId'] as const;

function parseDashboardOptions(item: Record<string, unknown>): Pick<NewApiOptions, 'dashboardAccessToken' | 'dashboardUserId'> {
  const result: Pick<NewApiOptions, 'dashboardAccessToken' | 'dashboardUserId'> = {};
  if (item.dashboardAccessToken !== undefined) {
    if (typeof item.dashboardAccessToken !== 'string' || item.dashboardAccessToken.trim() === '') throw new QuotaConfigError();
    result.dashboardAccessToken = item.dashboardAccessToken;
  }
  if (item.dashboardUserId !== undefined) {
    if (typeof item.dashboardUserId !== 'number'
      || !Number.isSafeInteger(item.dashboardUserId) || item.dashboardUserId <= 0) throw new QuotaConfigError();
    result.dashboardUserId = item.dashboardUserId;
  }
  return result;
}

function parseFooterWindows(value: unknown): FooterWindows {
  if (value === 'all') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  throw new QuotaConfigError();
}

export class QuotaConfigError extends Error {
  constructor() {
    // Settings may accidentally contain secrets. Never echo content/values.
    super('Invalid settings.json quotaUsage. Use providers with adapter "new-api", "deepseek", "sub2api", "opencode-go", "yescode", "exec" or "alias", and optionally footerWindows as a positive integer or "all".');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseQuotaConfig(value: unknown): QuotaConfig {
  if (!record(value) || Object.keys(value).some(key => key !== 'providers' && key !== 'footerWindows')
    || !record(value.providers) || Object.keys(value.providers).length > 64) throw new QuotaConfigError();
  const providers: Record<string, ProviderQuotaConfig> = Object.create(null);
  for (const [provider, item] of Object.entries(value.providers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(provider)
      || ['openai-codex', 'kimi-coding', 'opencode-go'].includes(provider)
      || !record(item)) throw new QuotaConfigError();
    if (item.adapter === 'deepseek') {
      if (Object.keys(item).some(key => key !== 'adapter')) throw new QuotaConfigError();
      providers[provider] = { adapter: 'deepseek' };
      continue;
    }
    if (item.adapter === 'sub2api' || item.adapter === 'opencode-go') {
      if (Object.keys(item).length !== 1) throw new QuotaConfigError();
      providers[provider] = { adapter: item.adapter };
      continue;
    }
    if (item.adapter === 'yescode') {
      if (Object.keys(item).some(key => !['adapter', 'username', 'password'].includes(key))
        || typeof item.username !== 'string' || typeof item.password !== 'string') throw new QuotaConfigError();
      try {
        providers[provider] = { adapter: 'yescode',
          ...validateYesCodeOptions({ username: item.username, password: item.password }) };
      } catch { throw new QuotaConfigError(); }
      continue;
    }
    if (item.adapter === 'exec') {
      if (Object.keys(item).some(key => !['adapter', 'command', 'label'].includes(key))) throw new QuotaConfigError();
      try {
        providers[provider] = { adapter: 'exec', ...validateExecOptions(item) };
      } catch { throw new QuotaConfigError(); }
      continue;
    }
    if (item.adapter === 'alias') {
      if (Object.keys(item).some(key => key !== 'adapter' && key !== 'of')
        || typeof item.of !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(item.of)
        || item.of === provider) throw new QuotaConfigError();
      providers[provider] = { adapter: 'alias', of: item.of };
      continue;
    }
    if (item.adapter !== 'new-api'
      || Object.keys(item).some(key => !['adapter', 'quotaPerUnit', 'currency', ...DASHBOARD_KEYS].includes(key))
      || (item.quotaPerUnit !== undefined && typeof item.quotaPerUnit !== 'number')
      || (item.currency !== undefined && typeof item.currency !== 'string')) throw new QuotaConfigError();
    try {
      const settings = validateNewApiOptions({ quotaPerUnit: item.quotaPerUnit, currency: item.currency });
      providers[provider] = { adapter: 'new-api', ...settings, ...parseDashboardOptions(item) };
    } catch { throw new QuotaConfigError(); }
  }
  const config: QuotaConfig = { providers };
  if (value.footerWindows !== undefined) config.footerWindows = parseFooterWindows(value.footerWindows);
  return config;
}

export function loadQuotaFooterWindows(settings: unknown): FooterWindows | undefined {
  if (!record(settings) || settings.quotaUsage === undefined) return undefined;
  return parseQuotaConfig(settings.quotaUsage).footerWindows;
}

export function loadQuotaAdaptersFromSettings(settings: unknown): QuotaAdapter[] {
  if (!record(settings) || settings.quotaUsage === undefined) return [];
  const config = parseQuotaConfig(settings.quotaUsage);
  return Object.entries(config.providers).flatMap(([provider, options]) => {
    switch (options.adapter) {
      case 'alias': return []; // Aliases declare no adapter; extension.ts wires them.
      case 'deepseek': return createDeepSeekAdapter(provider);
      case 'sub2api': return createSub2ApiAdapter(provider);
      case 'opencode-go': return createOpenCodeGoAdapter(provider);
      case 'yescode': return createYesCodeAdapter(provider, options);
      case 'exec': return createExecAdapter(provider, options);
      case 'new-api': return createNewApiAdapter(provider, options);
    }
  });
}

export function loadQuotaAliasesFromSettings(settings: unknown): Record<string, string> {
  if (!record(settings) || settings.quotaUsage === undefined) return {};
  const config = parseQuotaConfig(settings.quotaUsage);
  const aliases: Record<string, string> = Object.create(null);
  for (const [provider, options] of Object.entries(config.providers)) {
    if (options.adapter === 'alias') aliases[provider] = options.of;
  }
  return aliases;
}

export interface ComposedQuota {
  registry: AdapterRegistry;
  aliases: Record<string, string>;
  footerWindows: FooterWindows | undefined;
}

/**
 * The full quota surface in one place: built-in adapters, settings-bound adapters
 * and aliases wired exactly as the Pi extension does. Settings are deliberate user
 * bindings, so they take precedence over defaults; AdapterRegistry still detects an
 * ambiguous duplicate among explicit adapters. Alias providers share their target's
 * account: one hop only, and a dangling alias stays visible as an error instead of
 * vanishing silently.
 */
export function composeQuotaRegistry(input: {
  settings?: unknown;
  adapters?: readonly QuotaAdapter[];
  aliases?: Record<string, string>;
} = {}): ComposedQuota {
  const settingsAdapters = input.settings === undefined ? [] : loadQuotaAdaptersFromSettings(input.settings);
  const explicitAdapters = [...settingsAdapters, ...(input.adapters ?? [])];
  const aliases = { ...loadQuotaAliasesFromSettings(input.settings ?? {}), ...(input.aliases ?? {}) };
  const explicitProviderIds = new Set([...explicitAdapters.map(adapter => adapter.provider), ...Object.keys(aliases)]);
  const registry = new AdapterRegistry([
    codexAdapter, kimiAdapter, openCodeGoAdapter, createDeepSeekAdapter('deepseek'),
  ].filter(adapter => !explicitProviderIds.has(adapter.provider)).concat(explicitAdapters));
  for (const [alias, targetId] of Object.entries(aliases)) {
    const target = aliases[targetId] === undefined ? registry.get(targetId) : undefined;
    registry.register(target ? createAliasAdapter(alias, target) : createDanglingAliasAdapter(alias));
  }
  return {
    registry,
    aliases,
    footerWindows: input.settings === undefined ? undefined : loadQuotaFooterWindows(input.settings),
  };
}
