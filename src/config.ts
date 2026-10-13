// Back-compatible surface: the implementation lives in the Pi-free query layer
// (src/query/settings.ts) so non-Pi consumers can compose the same registry.
export {
  composeQuotaRegistry,
  loadQuotaAdaptersFromSettings,
  loadQuotaAliasesFromSettings,
  loadQuotaFooterWindows,
  parseQuotaConfig,
  QuotaConfigError,
} from './query/settings.ts';
export type { ComposedQuota, FooterWindows, ProviderQuotaConfig, QuotaConfig } from './query/settings.ts';
