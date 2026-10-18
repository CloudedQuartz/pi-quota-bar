# @astrosheep/pi-quota

Compact quota status for Pi: Codex, Kimi, OpenCode Go and DeepSeek work out of the box; new-api, Sub2API and YesCode use explicit provider bindings.

```bash
pi install npm:@astrosheep/pi-quota
```

Reload Pi after installing or changing settings. Use `/usage` for a persistent, context-free snapshot of providers with available quota data, including the current one. Use `/usage --all` to inspect provider errors. Automatic footer polling never adds chat items.

## What it shows

| Kind | Footer | `/usage` |
|---|---|---|
| Usage limit with a known period | `5h [▆] 72% ↺ 2h15m` | Horizontal bar, remaining percentage, reset, exact amounts if available |
| Wallet | `Bal $12.34` | Each finite balance, separately from limits and spend |
| Amount-based limit without a supplied period | `Key quota [▇] $85.00` | Remaining percentage plus exact remaining/used/cap amounts |
| Unlimited limit | `Key quota ∞` | Unlimited, without fake money or a percentage |
| Spending | Not shown | Today expenses; Lifetime is retained in data, not displayed |

A percentage always means **remaining**, not used. Unknown is `[?] ?`; an expired reset is `↺ due` with the stale percentage hidden until the next successful query. A wallet balance never becomes a percentage. Historical spend is not a quota.

The footer shows every balance, then limits in adapter order, capped at two by default — set `quotaUsage.footerWindows` to a positive integer or `"all"` to show more — followed by `+N` for limits it did not show, for the current provider only. Shared limits are preferred over scoped ones, so a scoped limit can be counted in `+N`. `/usage` queries all configured supported providers and shows every balance, limit and Today spending entry, grouped by provider; it does not open a modal or send messages to the model. Snapshots remain frozen at capture time. Query failures replace stale values in the footer and appear in `/usage --all`.

## Configure providers

Add bindings in global `~/.pi/agent/settings.json` under `quotaUsage` (not project settings):

```json
{
  "quotaUsage": {
    "providers": {
      "my-sub2api": { "adapter": "sub2api" },
      "my-new-api": { "adapter": "new-api", "quotaPerUnit": 500000, "currency": "USD" },
      "deepseek": { "adapter": "deepseek" },
      "opencode-go-2": { "adapter": "opencode-go" },
      "yes-vg": { "adapter": "yescode", "username": "you@example.com", "password": "..." },
      "my-script": { "adapter": "exec", "command": ["my-quota-cli", "--json"], "label": "My Script" },
      "my-alias": { "adapter": "alias", "of": "my-sub2api" }
    }
  }
}
```

Use the **exact Pi provider ID**. Built-in providers and explicitly bound providers are queried; explicit bindings replace a built-in adapter with the same ID. Unknown keys or adapter options are rejected. The API key comes from Pi's provider auth, and the endpoint comes from the provider's registered model; do not put model API keys in `quotaUsage`.

| Adapter | Endpoint | Result |
|---|---|---|
| `sub2api` | `{baseUrl}/usage` | Wallet, key quota, rate windows or subscription day/week/month windows; API-key Today/Lifetime actual spend |
| `new-api` | Account PAT `/api/user/self`, falling back to key-native billing/token endpoints | Account balance + lifetime spend; key limits (finite or unlimited), with no invented renewal |
| `deepseek` | Official `/user/balance` | All reported currency balances; no invented spend |
| `opencode-go` | Official `https://opencode.ai/zen/go/v1/usage` | 5h/1w/30d windows, same as the built-in `opencode-go` adapter |
| `yescode` | `co.yes.vg` login → session → `/api/v1/auth/profile` + `/api/v1/user/balance` | Separate subscription/pay-as-you-go balances plus scoped subscription limits |
| `exec` | Runs `command` as argv (no shell), parses stdout as a `QuotaSnapshot` JSON | Whatever the command reports; `fetchedAt` is stamped by the adapter, never by the command |
| `alias` | No endpoint — delegates to the `of` binding (built-in or explicit) | Shares the target account's quota; one folded row in `/usage` |

Bind `opencode-go` to a second OpenCode Go account: register it as its own Pi provider in `models.json` with its own `apiKey` (e.g. `opencode-go-2`), then bind that ID here. The built-in `opencode-go` binding is implicit and needs no entry; the reserved IDs `openai-codex`, `openai`, `kimi-coding` and `opencode-go` cannot be rebound.

The built-in `openai` provider shares the Codex usage endpoint: OpenAI's "Sign in with ChatGPT" OAuth exposes the subscription's Codex pool under both Pi provider IDs, so a session on `openai` shows the same 5h/weekly windows as `openai-codex`, queried with `openai`'s own credential. An `openai` login carried by an API key instead cannot access ChatGPT subscription usage and reports an `unsupported-auth` error rather than guessing.

Sub2API accepts no extra settings; it preserves deployment subpaths. Rate-only keys need not expose a top-level currency (rates are USD). Unknown rate-window durations and invalid limits fail rather than inventing a 1d window. Subscription periods without a cap are omitted. Its dashboard `/api/v1/usage` is a separate, JWT-authenticated paginated request log; the adapter uses the API-key `/v1/usage` instead.

For new-api, `quotaPerUnit` defaults to `500000`, `currency` to `USD`. Optionally add `dashboardAccessToken` (console system access token) and `dashboardUserId` (positive numeric ID required by some old forks) to that provider. This PAT is the **only** optional secret kept in settings. The account endpoint takes precedence; failures fall back to the key-native billing and token usage paths. Without a PAT, an API key cannot read the dashboard account quota. A finite key reports a known percentage only when `total_granted` is present and consistent with used plus remaining; otherwise its limit retains exact used/remaining with `amounts.limit: null` and an unknown percentage. It never becomes a wallet. `unlimited_quota` and legacy billing's unlimited sentinel become unlimited **limits**, not infinite balances. Values in settings and server error bodies are never logged.

For YesCode, `username` is the account email and `password` the account password; both stay in global `settings.json`, which is the trade-off of this adapter. YesCode rejects API keys on account endpoints ("requires a user session or JWT"), so the adapter logs in via `/api/v1/auth/login`, caches the issued cookie/JWT in memory for ~23 hours, and re-logs in once on an auth failure. The model `cr_` key is never sent to account endpoints; it only pins the provider to the official `co.yes.vg` origin. Subscription and pay-as-you-go balances remain separate; daily/weekly limits appear only when the account actually has those caps. Only an explicitly reported next reset is preserved; `last_*_reset` does not establish a future schedule.

Exec runs the configured argv without a shell and parses stdout as a JSON object with required `balances`, `limits` and `spending` arrays — the same schema every adapter produces, enforced by the controller. This is a **breaking query/exec contract migration**: legacy `windows`, `balance`, `allowance` and `spend` fields are rejected, not converted. `fetchedAt` is stamped by the adapter; a value from the command is ignored. The controller bounds every query (10s default) and kills the child on timeout; non-zero exits, unreadable JSON and output over 256KB become errors, and command output is never logged. The child inherits Pi's environment, so keep secrets in env vars, not in `quotaUsage`.

Alias binds a second provider ID to the same account: `"of"` names the real binding, which may be a built-in or an explicit adapter. The alias never queries on its own — a session on the alias shows the target's quota in the footer, queried under the target's identity and credentials, and `/usage` folds the alias into the target's single row with the session pin (and ★) following the fold. Aliases are one hop: `of` must not itself be an alias, and an alias whose target is not configured fails visibly instead of vanishing.

Authenticated quota URLs must use HTTPS, except HTTP loopback for local deployments. URL userinfo, query strings, fragments and HTTP redirects are rejected; credentials never follow redirects. Fixed official endpoints reject custom origins. No browser cookie scraping or credential discovery.

## Architecture

```text
Pi model/auth → adapter → QuotaSnapshot → controller → footer / /usage / state event
```

- `src/query/`: protocol-specific parsing, credential resolution, safe URLs, bounded GET client, state validation and controller. No Pi/TUI imports.
- `src/config.ts`: strict global provider bindings.
- `src/bar/`: pure compact rendering and persistent multi-provider chat card.
- `src/extension.ts` and `src/index.ts`: Pi lifecycle and auth bridge.

`QuotaSnapshot` preserves three independent concepts: `balances` (owned money), `limits` (periodic and non-periodic allowances), and `spending` (reported expenses, not necessarily wallet debit or limit consumption). Pi providers only select/bind adapters; the model adds no inferred owner/account graph. Custom adapters can be passed to `createQuotaExtension({ adapters: [...] })`; see `examples/custom-provider.ts`. Provider aliases are never inferred.

The extension publishes structured state on `quota-bar:state:v2` and saves usage cards under `quota-bar:usage:v2`; old contract events/cards are not migrated. Use `createQuotaExtension({ footer: false })` to consume it without this extension's footer. Normal queries are throttled, cancellable, timeout-bounded and backed off after errors. `/usage` forces a fresh query for every configured supported provider, then omits failed results from its default view. Switching provider discards old footer values immediately.

## Snapshot schema

All types below are named exports of `@astrosheep/pi-quota/query`:

```ts
interface Balance {
  id: string;
  label: string;
  currency: string;
  remaining: number;
}
interface LimitAmounts {
  unit: string;
  limit: number | null;
  used: number;
  remaining: number;
}
interface UsageLimit {
  id: string;
  label: string;
  scope?: string;
  remainingPercent: number | null;
  resetAt: number | null;
  durationSeconds?: number;
  amounts?: LimitAmounts;
  unlimited?: true;
}
interface Spending {
  id: string;
  label: string;
  currency: string;
  amount: number;
  period: 'today' | 'lifetime';
}
interface QuotaSnapshot {
  balances: Balance[];
  limits: UsageLimit[];
  spending: Spending[];
  fetchedAt: number;
}
```

- All three arrays are required, with at most 64 entries each. Spend-only snapshots are valid; all-empty snapshots are not.
- IDs are nonblank, control-free strings of at most 64 characters, unique **within each category**. They are opaque and preserved exactly, never derived from duration: two `5h` limits with different IDs remain distinct. Labels/scopes/units are sanitized for terminal safety, trimmed and bounded to 64 characters; blank values are rejected.
- Currency is a three-letter uppercase code. Balances are finite, including zero and negative debt. They cannot be unlimited.
- Percentages are finite values in `[0, 100]`, always **remaining**; `null` means unknown. Exact amounts and provider percentages need not agree after rounding or provider-specific accounting. `limit` is nonnegative or `null` (cap not reported); `used` is nonnegative; `remaining` is finite and may be negative. Amount units can be currencies or counts such as `tokens`/`requests`; counts are not formatted as money.
- Unlimited limits use `unlimited: true`, `remainingPercent: null`, and no `amounts`. Unknown cap (`amounts.limit: null`) does **not** mean unlimited.
- `fetchedAt` and `resetAt` are epoch milliseconds; `resetAt` is positive or `null`. A supplied duration must be positive. Missing duration/reset is unknown, not proof of no renewal. No fixed/rolling classification or future reset schedule is inferred.
- Spending amounts are finite and nonnegative. `today` means the **provider-defined day**, with no inferred timezone. Both periods are retained in snapshots, but the footer omits spending and `/usage` displays only Today.

For example, an exec command can emit this (no `fetchedAt` required):

```json
{
  "balances": [{ "id": "wallet", "label": "Balance", "currency": "USD", "remaining": 12.34 }],
  "limits": [{
    "id": "requests", "label": "Requests", "remainingPercent": 80, "resetAt": null,
    "amounts": { "unit": "requests", "limit": 100, "used": 20, "remaining": 80 }
  }],
  "spending": [{ "id": "today", "label": "Reported spend", "currency": "USD", "amount": 2.5, "period": "today" }]
}
```

## Standalone query layer

Non-Pi consumers (bridges, plugins, scripts) can import the query layer without pulling in the Pi extension or its peer dependencies:

```ts
import {
  AdapterRegistry, codexAdapter, createJsonClient, createPostJsonClient,
} from '@astrosheep/pi-quota/query';

const registry = new AdapterRegistry([codexAdapter]);
const snapshot = await registry.get('openai-codex')!.query({
  provider: 'openai-codex',
  signal: AbortSignal.timeout(10_000),
  now: () => Date.now(),
  getAuth: myAuthResolver,      // you supply credentials
  getJson: createJsonClient(),
  postJson: createPostJsonClient(),
});
```

The subpath exports every adapter, the registry/controller, option validators, HTTP/exec plumbing, and all query types. Peer dependencies are marked optional, so installing for the query layer alone stays light.

## Development

Requires Node ≥22.18 and a compatible Pi installation.

```bash
npm install --ignore-scripts
npm test
npm run typecheck
npm run build
npm run demo
```
