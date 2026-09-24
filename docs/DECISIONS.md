# Implementation decisions

The brief (`docs/PRODUCT_BRIEF.md`) is the product source of truth. This log records how it was
interpreted, where the implementation differs, and why. Newest entries at the bottom of each section.

---

## Architecture

### D-01 · Data access goes straight to Postgres, with RLS still enforced
**Decision.** Server code talks to Postgres through the `postgres` driver (`packages/db`) instead of
Supabase's REST layer. Every owner-facing request runs inside `withOwner()`, which opens a
transaction, sets the verified JWT claims and switches to the `authenticated` role. Row Level Security
therefore applies exactly as it would through the Supabase API.

**Why.** One code path serves the web app, the jobs and the tests. Transactions make multi-row changes
(plan acceptance, capture reconciliation, budget reservations) atomic. The whole data layer, including
RLS, can be tested against a real Postgres in CI without the Supabase Docker stack.

**Guardrails.** `withService()` (bypasses RLS) is reserved for jobs and for flows that authenticate by
other means first (OAuth callbacks, capture tokens). On Vercel the connection uses the Supavisor
transaction pooler with prepared statements disabled.

### D-02 · Single-owner model enforced in the database
`private.owner` holds exactly one row. Every public table uses the policy `public.is_owner()`, installed by
`private.secure_owner_table()`. The Google identity must match `OWNER_EMAIL` and be verified by Google
before the auth callback claims ownership. A second Supabase user, including anyone who completes
Google sign-in with another address, can read and write nothing, and the callback removes that user.
Mailbox connections use their own OAuth flow and never touch Supabase Auth, so connecting a second
mailbox cannot change the owner.

`packages/db/test/security-invariants.test.ts` fails the build if any public table lacks RLS or a
policy, if `anon` holds any table grant, or if `anon` can execute any public function.

### D-03 · Workspace packages
`packages/core` holds pure logic, `packages/db` data access, `packages/integrations` provider HTTP
clients (network only through an injected `fetch`), and `packages/jobs` job handlers. The brief's
suggested layout had `apps/web`, `apps/extension`, `packages/core`, and the `supabase` folders. The
two extra packages let job handlers be tested with Vitest in Node and then run unchanged in the Deno
Edge Function, which imports them through an import map. The research confirms that Supabase CLI
deploys can bundle files outside `supabase/functions` as long as they sit inside the git root.

### D-04 · Toolchain versions
Next.js 16.3.6, React 19.3, Tailwind 4.3, `@supabase/ssr` 0.12.7, Vitest 5, Playwright 1.63, and Node 22.
TypeScript is pinned to **6.0.x**. TypeScript 7 (the native port) is the npm `latest`, but
typescript-eslint supports only versions below 6.1. ESLint is pinned to **9.x**, because
`eslint-plugin-react` (pulled in by `eslint-config-next`) does not support ESLint 10 yet.

### D-05 · Supabase keys and job authentication
Supabase's new `sb_publishable_…`/`sb_secret_…` keys are not JWTs, and projects created after
November 2025 have no legacy anon or service_role keys. The app reads `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
and `SUPABASE_SECRET_KEY`. The dispatcher Edge Function sets `verify_jwt = false` and authenticates
pg_cron calls with its own secret header (`x-dispatcher-secret`), compared in constant time. A public
key alone cannot trigger jobs.

### D-06 · `auth.jwt() ->> 'sub'` instead of `auth.uid()`
Supabase now marks `auth.uid()` as deprecated. `public.is_owner()` reads the subject from `auth.jwt()`.

---

## Testing

### D-10 · Real Postgres for tests, without Docker images
The Supabase local stack cannot be pulled in the build container (its image CDN and Docker Hub are blocked or
rate limited). `scripts/local-db.mjs` runs a throwaway Postgres 16 cluster, and
`supabase/tests/shim/supabase_shim.sql` recreates the parts of Supabase the migrations depend on:
roles, `auth.uid()`/`auth.jwt()`, a minimal `auth.users` and `storage`, and Supabase's permissive
default grants on `public`. Tests clone a template database built by content hash, so parallel
runs never collide. The shim is never applied to a real project.

### D-11 · Test-only sign-in for Playwright
Google sign-in cannot run in CI. When `PH_E2E_AUTH=1` and a secret of at least 32 characters are both set,
and the app is **not** running on Vercel, `/api/test/login` issues an HMAC-signed session cookie for the
owner already recorded in the database. RLS still applies. On Vercel the route returns 404, and the check
cannot be switched back on there.

---

## Product interpretations

### D-20 · Chrome helper: passive capture by default, background revisits opt-in
Research on 24 Sep 2026 (`docs/research/chat-dom.md`) found that Anthropic's consumer terms prohibit
scraping and automated or non-human access, and OpenAI's terms prohibit automatically or
programmatically extracting Output. Neither has a carve-out for a personal extension. The brief asks
for this helper and forbids bypassing access controls or harvesting cookies. So:

- **Default: passive capture.** The helper records only conversations the owner has selected, and
  only while the owner has them open in their own signed-in browser. It uses no internal APIs, reads no
  cookies and bypasses no challenges.
- **Background revisits (every 30 minutes).** Built as the prototype the brief asks for, but **off by
  default** behind an explicit opt-in that explains the terms-of-use risk. The collector tab is visible
  and the helper can be paused.
- The sanctioned alternative is each service's official data export. It is manual, so under the brief
  it does not satisfy automatic collection.

The owner decides whether to enable revisits. Automatic capture stays listed as an unresolved
requirement until it is verified on real accounts.

### D-21 · Long conversations are virtualised
Both chat apps now unmount turns that are off screen. The helper builds up turns as they mount and
records honest coverage (`observedFirstMessage`, `observedLastMessage`). A partial page can add to or
update stored messages but can never shrink them.
