// Public entry for the standalone query layer — no Pi, terminal, or rendering
// dependencies. Consumers supply auth and transport through QueryContext.
export * from './types.ts';
export { AdapterRegistry, validateSnapshot } from './registry.ts';
export { QuotaController } from './controller.ts';
export { createJsonClient, createPostJsonClient, officialAuth, bearer, header } from './http.ts';
export { createAliasAdapter, createDanglingAliasAdapter } from './alias.ts';
export { createExecAdapter, validateExecOptions } from './exec.ts';
export type { ExecOptions } from './exec.ts';
export { codexAccountId, codexAdapter } from './codex.ts';
export { kimiAdapter } from './kimi.ts';
export { openCodeGoAdapter, createOpenCodeGoAdapter } from './opencode-go.ts';
export { createDeepSeekAdapter, DEEPSEEK_ORIGIN } from './deepseek.ts';
export { createNewApiAdapter, validateNewApiOptions } from './new-api.ts';
export type { NewApiOptions } from './new-api.ts';
export { createSub2ApiAdapter } from './sub2api.ts';
export { createYesCodeAdapter, validateYesCodeOptions, YESCODE_ORIGIN } from './yescode.ts';
export type { YesCodeOptions } from './yescode.ts';
export {
  composeQuotaRegistry, loadQuotaAdaptersFromSettings, loadQuotaAliasesFromSettings,
  loadQuotaFooterWindows, parseQuotaConfig, QuotaConfigError,
} from './settings.ts';
export type { ComposedQuota, FooterWindows, ProviderQuotaConfig, QuotaConfig } from './settings.ts';
