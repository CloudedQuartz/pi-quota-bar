import { QuotaError } from './types.ts';
import type { QuotaAdapter } from './types.ts';

// An alias provider shares another provider's account: the query runs under
// the target's identity, so auth and endpoints resolve exactly as a direct
// query of the target would. The alias never queries on its own behalf.
export function createAliasAdapter(provider: string, target: QuotaAdapter): QuotaAdapter {
  return {
    provider, label: target.label,
    query: context => target.query({ ...context, provider: target.provider }),
  };
}

// A dangling alias stays visible as an error instead of silently vanishing.
export function createDanglingAliasAdapter(provider: string): QuotaAdapter {
  return {
    provider, label: provider,
    query: () => Promise.reject(new QuotaError('unsupported-auth')),
  };
}
