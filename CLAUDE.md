# Personal Home — engineering conventions

Private, single-owner personal dashboard. Product source of truth: `docs/PRODUCT_BRIEF.md`.
Implementation decisions that interpret or deviate from the brief go in `docs/DECISIONS.md`.
Integration verification status goes in `docs/INTEGRATION_RESULTS.md` — never claim an
integration works unless it was actually exercised against the real provider.

## Layout

| Path | What |
|---|---|
| `packages/core` | Pure domain logic + zod schemas. **No I/O**, no Node-only APIs. Runs in Node, browsers and Deno. |
| `packages/db` | Postgres access (`postgres` driver). `withOwner` (RLS-enforced, role `authenticated`) and `withService` (jobs/trusted flows). Repositories live here. Test harness: `@personal-home/db/testing`. |
| `packages/integrations` | Provider HTTP clients/adapters (Google, Microsoft, Lunch Flow, ...). Network only via an injected `fetch`; no DB. |
| `packages/jobs` | Job handlers + dispatcher loop. Vitest in Node; executed by the Deno Edge Function. |
| `apps/web` | Next.js 16 App Router + Tailwind v4 PWA. |
| `apps/extension` | Chrome MV3 capture helper (esbuild). |
| `supabase/migrations` | SQL migrations, applied in filename order. |
| `supabase/functions` | Deno Edge Functions (dispatcher + job handlers). |
| `scripts/local-db.mjs` | Throwaway local Postgres 16 (no Docker needed). |
| `docs/` | Brief, decisions, integration results, setup. |

## Hard rules

- **Next.js 16 is not the Next.js in your training data.** Before writing Next code, read the
  relevant file under `apps/web/node_modules/next/dist/docs/` (e.g. `01-app/01-getting-started/16-proxy.md`,
  `01-app/02-guides/progressive-web-apps.md`, `01-app/02-guides/forms.md`, `01-app/02-guides/server-actions.md`).
  `middleware.ts` is now `proxy.ts`. `params`, `searchParams`, `cookies()`, `headers()` are async.
- TypeScript is pinned to 6.0.x (typescript-eslint does not support 7 yet). ESLint 9.
- Imports inside `packages/*` use **explicit `.ts` extensions** for relative paths (Deno compatibility).
- Cross-package imports use the package root only (`@personal-home/core`, never `@personal-home/core/x`).
  Each package re-exports its areas through `src/<area>/index.ts` barrels; keep exported names area-prefixed
  enough to avoid collisions (e.g. `captureReconcile`, `CaptureSnapshot`).
- `src/` of every package must run in Deno and browsers: no `node:*` imports, no `Buffer`, no `process`
  (use `globalThis.crypto`, `TextEncoder`, `Uint8Array`, `btoa/atob`; pass config in as arguments).
  Node-only code is fine in `test/` files, `apps/web` server code and `scripts/`.
- `apps/web` uses `@/` for app paths.
- Never commit secrets. Never log tokens, mail bodies, journal text, or full captured conversations.
- Test fixtures must not contain credential-shaped literals (`sk_live_…`, `GOCSPX-…`, `AKIA…`, `ghp_…`,
  `-----BEGIN … PRIVATE KEY-----`): GitHub push protection rejects them even when fake. Build such
  strings at runtime (e.g. `` `sk_${'live'}_…` ``) and label them synthetic.
- Never fabricate data: no fake zeros, no "no events" when a source failed. Use the `DataState`
  and `ConnectionStatus` vocab in `packages/core/src/catalog.ts`.
- Demo/fixture data must be labelled (`DataState` `demo`) and must never appear in real-account mode.
- No automatic external actions (no sending mail, no payments, no calendar writes, no cancellations).
- Spotify content/metadata/artwork must never enter AI prompts.

## Database conventions

- Migration files: `supabase/migrations/YYYYMMDDHHMMSS_name.sql`. Never edit a migration another
  area owns; add a new file.
- Every table in `public` **must** end with `select private.secure_owner_table('public.<table>');`
  (enables RLS, revokes anon, installs the `public.is_owner()` policy, adds the `updated_at` trigger).
  `packages/db/test/security-invariants.test.ts` fails otherwise.
- Standard columns: `id uuid primary key default gen_random_uuid()`, `created_at timestamptz not null default now()`,
  `updated_at timestamptz not null default now()`.
- Secrets (encrypted tokens, token hashes) live in the `private` schema, touched only via `withService`.
- Functions in `public` must `revoke execute ... from public, anon` unless intentionally public.
  Security-definer functions must `set search_path = ''` and schema-qualify everything.
- Trigger functions run as the invoking role: don't call `private.*` functions from triggers
  on owner tables unless the trigger function is `security definer`.
- Local calendar dates use `date` (returned as `'YYYY-MM-DD'` strings). Instants use `timestamptz`.
  Money uses `amount_minor bigint` + `currency char(3)`.
- The `postgres` client uses `postgres.camel`: result columns come back camelCase; static SQL text stays snake_case;
  `sql(obj)` insert helpers accept camelCase keys.

## Testing

- `node scripts/local-db.mjs start` then `pnpm --filter @personal-home/db test` (vitest global setup
  rebuilds `ph_template` = Supabase shim + all migrations; each test file clones it).
- Use `packages/db/test/harness.ts`: `createTestDatabase()`, `seedOwner()`, `createAuthUser()`, `withAnon()`.
- Domain logic: Vitest in the owning package. UI flows: Playwright in `apps/web/e2e` using the
  test-only auth (`PH_E2E_AUTH=1` + `PH_E2E_AUTH_SECRET`, disabled on Vercel).
- Run the package's `typecheck`, `lint` and `test` before declaring work done.
- The container has no outbound internet except package registries: provider APIs cannot be
  called from here. Use recorded/synthetic fixtures and say so.

## UI conventions

- Light, calm, moderate density. Tokens in `apps/web/app/globals.css` (`bg-surface`, `text-ink-muted`, `border-line`,
  `bg-accent`, `bg-tentative-soft` for AI/tentative suggestions, etc.).
- Components: `components/ui/{card,button,empty-state,status-pill,planned-section}.tsx`, shell in `components/shell`.
- Every page under `app/(app)` calls `requireOwner()` (or reads via `withOwnerTx`) itself — never rely on the layout alone.
- Touch targets ≥ 44px on mobile, visible focus, semantic headings, labels on every input.
- Sections load independently (Suspense per module) and never block Home on a provider or AI call.
