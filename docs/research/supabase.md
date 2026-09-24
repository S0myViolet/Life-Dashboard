# Research notes: Supabase (current docs, verified 2026-09-24): Edge Functions, keys/JWT, pg_cron scheduling, auth.uid()/auth.jwt(), pooler + RLS from serverless, billing/backups, Storage RLS, Next.js SSR + Google auth

_Collected 2026-09-24 via web research (single pass, not yet re-verified). Sources are linked per fact. The build container itself cannot reach these hosts._

## Corrections and surprises

- The egress proxy blocks supabase.com and orm.drizzle.team, so WebFetch could not read the rendered docs pages. Every 'official doc' fact comes from the Markdown source the docs site is built from (raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/..., drizzle-team/drizzle-orm-docs) or from npm package source. A summarizing model read those files: code blocks are quoted, but some prose may be lightly paraphrased.
- The Edge Function scheduling doc no longer uses 'Authorization: Bearer <anon key>'. It sends the publishable key on the 'apikey' header, with Vault secrets named 'project_url' and 'publishable_key'. For a function that must only be callable by cron, the Edge auth doc says to send a SECRET key on apikey, set verify_jwt = false, and check it with withSupabase({ auth: 'secret' }) from npm:@supabase/server.
- The new sb_publishable_/sb_secret_ keys are not JWTs. They can't go in Authorization: Bearer, and the platform's verify_jwt check does not authenticate an API-key-only caller. Projects created or restored from 1 Nov 2025 have no anon/service_role keys at all, and legacy keys are scheduled for removal in late 2026 (TBC). Any design that relies on SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY or the legacy JWT secret is at risk.
- There is a new official package, @supabase/server (v1.8.0, withSupabase / createSupabaseContext). The docs now say not to read keys from env inside Edge Functions and to use it instead.
- Next.js docs now use lib/supabase/{client,server,proxy}.ts (not utils/supabase) and a root proxy.ts exporting `proxy` (Next 16). The env var is NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. The OAuth PKCE callback partial still imports from '@/utils/supabase/server', so the docs are inconsistent. In @supabase/ssr 0.12.x, setAll receives a second 'headers' argument (Cache-Control/Expires/Pragma) that the proxy must copy onto the response.
- The docs contradict each other on static files. The WASM doc says 'Static files cannot be deployed using the `--use-api` API flag', while the CLI deploy SIDE_EFFECTS.md says API deploys record `static_patterns`. Community reports on discussion #32815 describe static files silently not uploading with --use-api. Test before relying on static_files with API bundling.
- CLI 2.116.0 had a regression that broke local Edge Runtime startup for monorepo imports outside supabase/functions, caused by overlapping Docker bind mounts (issue #50088, fixed via supabase/cli#6505). 2.111.0 and 2.115.0 worked. The TS CLI only uploads imports inside the nearest git root, so packages outside the repo will not be uploaded.
- The supabase/cli repo is now a monorepo (apps/cli in TypeScript plus apps/cli-go). Old paths like cmd/functions.go and pkg/config/templates/config.toml return 404. The npm package supabase@2.117.0 ships the TS CLI with a Go sidecar.
- The Drizzle RLS example builds claims from getSession() plus an unverified decode, and interpolates them with sql.raw (the role and sub go straight into the SQL). Verify the token with auth.getClaims() first, and allow-list the role and escape or parameterize the values before copying the pattern.
- The Supabase Auth migration marks auth.uid(), auth.role() and auth.email() as 'Deprecated. Use auth.jwt() -> ''sub'' instead.' in function comments. The Storage docs now write policies as (select auth.jwt()->>'sub'), and they use a new helper, storage.allow_any_operation(...).
- The Edge Function wall-clock limit (150s Free / 400s paid) is how long a worker stays alive, not a per-request limit. CPU time is 2s per request. The request idle timeout (150s, then a 504) applies separately. The runtime memory cap is 256MB.

## Facts

### Q1: Each Edge Function should have its own deno.json. import_map.json is described as the legacy option. You can also set an import map per function in config.toml. **(load-bearing)**

Doc text: "Each function should have its own `deno.json` file to manage dependencies and configure Deno-specific settings." Layout: supabase/functions/function-one/{index.ts,deno.json}. Legacy per-function config: [functions.my-function]
import_map = "./functions/function-one/import_map.json" (the CLI flag is --import-map <string>). Import specifiers: 'npm:@supabase/supabase-js@2', 'node:process', 'jsr:@std/path@1.0.8'. For private npm packages, put a .npmrc in the function's own directory. Rendered page: https://supabase.com/docs/guides/functions/dependencies

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/functions/dependencies.mdx · confidence: verified-official-doc

### Q1: The docs recommend a _shared folder (any folder whose name starts with an underscore) for code shared between functions. Functions import from it with relative paths.

"you can store any shared code in a folder prefixed with an underscore (`_`)". Example: supabase/functions/_shared/{supabaseAdmin.ts,supabaseClient.ts,cors.ts}, imported as '../_shared/cors.ts'. The docs also recommend 'fat functions' (a few large functions instead of many small ones). Rendered page: https://supabase.com/docs/guides/functions/development-tips

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/functions/development-tips.mdx · confidence: verified-official-doc

### Q1: Functions can import TS files outside supabase/functions, for example monorepo packages mapped in the function's deno.json. Docker bundling (the default) adds a bind mount for each imported file outside supabase/functions and for each import-map directory target. API bundling (--use-api) uploads imports that sit outside the workdir but inside the nearest git root. **(load-bearing)**

Repro in the official issue (per-function deno.json): "@proj/entity-orm/": "../../packages/entity-orm/". CLI buildDockerBinds "walks the function's transitive local import graph and adds a bind for each imported file outside `supabase/functions`". CLI source SIDE_EFFECTS.md for deploy: "Imports outside the workdir but inside the nearest git root still upload, with `../`-relative names." It also says "The git-root containment boundary is a TS-only safeguard ... the old Go CLI uploaded any reachable import unbounded." Discussion #33613 (CLI >= 2.13.3) introduced `supabase functions deploy --use-api` for 'import files outside of supabase directory' in monorepos. Local `supabase functions serve` still needs Docker.

Source: https://github.com/supabase/supabase/issues/50088 ; https://raw.githubusercontent.com/supabase/cli/develop/apps/cli/src/commands/functions/deploy/SIDE_EFFECTS.md ; https://github.com/orgs/supabase/discussions/33613 · confidence: secondary-source

### Q1: By default `supabase functions deploy` bundles locally with Docker. `--use-api` bundles on the server instead. If the Docker daemon is stopped, the CLI falls back to API bundling. The three modes are mutually exclusive. **(load-bearing)**

CLI source: "Bundles locally with Docker by default (`--use-docker` defaults to true and is hidden); `--use-api` selects server-side bundling, and a stopped Docker daemon falls back to it after a `WARNING: Docker is not running`." and "`--use-api`, `--use-docker`, and `--legacy-bundle` are mutually exclusive deploy modes." Other flag: --prune deletes remote functions that are not present locally. Latest CLI on npm is supabase@2.117.0 (TS CLI with a Go sidecar).

Source: https://raw.githubusercontent.com/supabase/cli/develop/apps/cli/src/commands/functions/deploy/SIDE_EFFECTS.md · confidence: secondary-source

### Q1: The static_files config key exists. Set it per function in config.toml and read the files at runtime with Deno file APIs. It needs CLI 2.7.0 or later and supports globs.

[functions.buy-book]
static_files = [ "./functions/buy-book/my-book.pdf" ] (glob example: "./functions/email-templates/*.html"). Read with: await Deno.readFile("./my-book.pdf"). The WASM doc says: "You will need update Supabase CLI to 2.7.0 or higher for the `static_files` support." and "Static files cannot be deployed using the `--use-api` API flag." The changelog says the feature is not available with branching. Other config.toml per-function keys: verify_jwt, import_map, entrypoint (.ts/.js/.tsx/.jsx/.mjs).

Source: https://github.com/orgs/supabase/discussions/32815 ; https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/functions/wasm.mdx ; https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/functions/function-configuration.mdx · confidence: verified-official-doc

### Q2: Default environment variables available inside hosted Edge Functions. **(load-bearing)**

SUPABASE_URL (API gateway); SUPABASE_DB_URL (direct Postgres URL); SUPABASE_PUBLISHABLE_KEYS ("The `publishable` keys JSON dictionary"); SUPABASE_SECRET_KEYS ("The `secret` keys JSON dictionary ... These keys bypass Row Level Security"); SUPABASE_JWKS ("The JSON Web Key Set used to verify user JWTs"). Legacy: SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY. Hosted-only: SB_REGION, SB_EXECUTION_ID, DENO_DEPLOYMENT_ID ("{project_ref}_{function_id}_{version}"). Read with Deno.env.get('NAME'). Parse a key with: JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)['default']. Custom secret names "can't start with `SUPABASE_`". Set them with `supabase secrets set --env-file .env`; they apply without a redeploy. Local dev reads supabase/functions/.env. Rendered page: https://supabase.com/docs/guides/functions/secrets

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/functions/secrets.mdx · confidence: verified-official-doc

### Q3: Edge Function runtime and platform limits. **(load-bearing)**

Maximum Memory: 256MB. Maximum Duration (wall clock, how long a worker stays active; one worker can serve several requests and background tasks): Free 150s, Paid 400s. Maximum CPU Time: 2s per request, async I/O not counted. Request idle timeout: 150s, after which a 504 Gateway Timeout is returned. Function size: 20MB when bundled locally by the CLI, 5MB when bundled server-side (Management API or Dashboard). Functions per project: Free 100, Pro 1000, Team 2000. Log message max length 10,000 chars. Log events: 100 per 10s. Nested calls: 30 requests per trace within 60s. Secrets: 100 per project, name up to 256 chars, value up to 48 KiB. Outbound SMTP ports 25 and 587 are blocked. Ephemeral /tmp storage: Free 256MB, Paid 512MB, reset per invocation. Rendered page: https://supabase.com/docs/guides/functions/limits

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/functions/limits.mdx · confidence: verified-official-doc

### Q3: Background tasks use EdgeRuntime.waitUntil(promise). They stay bounded by the wall-clock, CPU and memory limits. **(load-bearing)**

EdgeRuntime.waitUntil(asyncLongRunningTask()); addEventListener('beforeunload', (ev) => { console.log('Function will be shutdown due to', ev.detail?.reason) }). "The maximum duration is capped based on the wall-clock, CPU, and memory limits." To test locally, set in config.toml: [edge_runtime]
policy = "per_worker". Types come from: import 'jsr:@supabase/functions-js/edge-runtime.d.ts'. Troubleshooting docs say waitUntil does not extend the hard wall-clock limit. Rendered page: https://supabase.com/docs/guides/functions/background-tasks

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/functions/background-tasks.mdx · confidence: verified-official-doc

### Q4: Documented pattern for scheduling an Edge Function with pg_cron, pg_net and Vault. The current doc sends the publishable key on the 'apikey' header and has no Authorization Bearer header. **(load-bearing)**

select vault.create_secret('https://project-ref.supabase.co', 'project_url');
select vault.create_secret('YOUR_SUPABASE_PUBLISHABLE_KEY', 'publishable_key');
select cron.schedule('invoke-function-every-minute', '* * * * *', $$
  select net.http_post(
    url:= (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/function-name',
    headers:=jsonb_build_object('Content-type', 'application/json', 'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')),
    body:=concat('{"time": "', now(), '"}')::jsonb
  ) as request_id;
$$);
Requires the pg_cron and pg_net extensions. Rendered page: https://supabase.com/docs/guides/functions/schedule-functions

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/functions/schedule-functions.mdx · confidence: verified-official-doc

### Q4: Signatures and helpers for pg_net, Vault and pg_cron. **(load-bearing)**

net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds int default 2000). Responses land in net._http_response (id, status_code, content_type, headers, content, timed_out, error_msg, created) and are kept 6h (setting pg_net.ttl). vault.create_secret(secret, name, description); vault.update_secret(id, secret, name, description); select * from vault.decrypted_secrets. Cron: select cron.unschedule('job-name'); select * from cron.job; select * from cron.job_run_details where jobid = ... order by start_time desc. A schedule of '30 seconds' is allowed on Postgres 15.1.1.61 or later. The cron quickstart Edge Function example uses timeout_milliseconds:=5000.

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/database/extensions/pg_net.mdx ; https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/database/vault.mdx ; https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/cron/quickstart.mdx · confidence: verified-official-doc

### Q4/Q5: For service-to-service calls (cron, pg_net, workers) the docs say to send a SECRET key on the apikey header, disable verify_jwt, and validate the key in code with @supabase/server using auth: 'secret'. **(load-bearing)**

Edge auth doc: "Cron jobs, workers, `pg_net`, or another Edge Function make calls with a secret key on the `apikey` header" and "Disable verify_jwt and use auth: 'secret' to validate the key against any secret key from your dashboard." config.toml: [functions.<name>]
verify_jwt = false. API keys doc: "Edge Functions need to authorize API keys in code. The `verify_jwt` check alone doesn't authenticate a caller that sends only an API key." Code: import { withSupabase } from 'npm:@supabase/server'; export default { fetch: withSupabase({ auth: 'secret' }, async (_req, ctx) => { const { data } = await ctx.supabaseAdmin.from('profiles').select('email'); return Response.json({ data }) }) }

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/functions/auth.mdx ; https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/getting-started/api-keys.mdx · confidence: verified-official-doc

### Q5: @supabase/server is a new official package for Edge Functions and other header-auth backends. Its withSupabase wrapper takes an auth mode and injects clients and claims into ctx.

npm @supabase/server@1.8.0 (modified 2026-09-22). Auth modes: 'user' (valid user JWT on Authorization), 'secret' (secret key on apikey), 'publishable' (publishable key on apikey), 'none' (no check), or an array like ['user','secret']. ctx has supabase (RLS-scoped), supabaseAdmin (bypasses RLS), userClaims, authMode. There is also createSupabaseContext(req, { auth: 'user' }) returning { data: ctx, error }. Choosing-a-package doc: cookies/SSR frameworks such as Next.js use @supabase/ssr; auth "per request in headers" (Edge Functions, Workers, Vercel, Hono...) uses @supabase/server.

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/functions/auth.mdx ; https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/auth/choosing-a-server-package.mdx · confidence: verified-official-doc

### Q5: The new API keys are sb_publishable_... (low privilege, replaces anon) and sb_secret_... (elevated, replaces service_role). They are not JWTs and go on the apikey header, not Authorization: Bearer. Secret keys return 401 when used from a browser. **(load-bearing)**

Key types: Publishable `sb_publishable_...` Low; Secret `sb_secret_...` Elevated; `anon` JWT (long-lived) Low; `service_role` JWT (long-lived) Elevated. "Send publishable and secret keys on the `apikey` header, not on `Authorization: Bearer`." "A secret key doesn't work in a browser. Supabase matches on the `User-Agent` header and returns HTTP 401 Unauthorized." "Public Realtime connections last a maximum of 24 hours, unless the connection is upgraded to user-level authentication." Rendered page: https://supabase.com/docs/guides/getting-started/api-keys

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/getting-started/api-keys.mdx · confidence: verified-official-doc

### Q5: Legacy anon and service_role keys still work alongside the new keys on existing projects. Projects created or restored from 1 Nov 2025 no longer have them, and deletion is planned for late 2026 (date TBC). **(load-bearing)**

Docs: "Creating publishable and secret keys doesn't revoke your legacy keys. Both key systems work at the same time." They stay valid until you disable them under Settings > API Keys. Timeline in official discussion #29260: "Projects restored from 1st November 2025 will no longer be restored with the legacy API keys. New projects no longer have `anon` and `service_role` available for use." and "Late 2026 (TBC): Legacy API keys will be deleted and removed from the Docs / Dashboard." Revoking the legacy JWT secret also invalidates anon/service_role, because they are JWTs signed by it.

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/getting-started/api-keys.mdx ; https://github.com/orgs/supabase/discussions/29260 · confidence: verified-official-doc

### Q5: Asymmetric JWT signing keys use ES256 (recommended) or RS256. HS256 is legacy and not recommended for production. Keys are published at a JWKS endpoint.

GET https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json. The endpoint is "cached by Supabase's edge servers for 10 minutes. Furthermore the Supabase client libraries may cache the keys in memory for an additional 10 minutes." Migration: Migrate JWT secret, then a standby key, then Rotate keys, then revoke the legacy secret. "Wait at least 1 hour and 15 minutes before revoking the legacy JWT secret" (with 1h token expiry). Rendered page: https://supabase.com/docs/guides/auth/signing-keys

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/auth/signing-keys.mdx · confidence: verified-official-doc

### Q5: supabase.auth.getClaims(jwt?, { allowExpired?, jwks? }) checks the JWT locally with WebCrypto against a cached JWKS when the token is asymmetric. For HS* tokens, tokens without a kid, or runtimes without WebCrypto, it calls getUser() on the server. **(load-bearing)**

Verified in @supabase/auth-js@2.117.1, src/GoTrueClient.ts. Return type: { data: { claims: JwtPayload; header: JwtHeader; signature: Uint8Array }, error: null } | { data: null; error: AuthError } | { data: null; error: null }. Fallback logic: `!header.alg || header.alg.startsWith('HS') || !header.kid || !('crypto' in globalThis && 'subtle' in globalThis.crypto) ? null : await this.fetchJwk(...)`, and if there is no signing key it runs `await this.getUser(token)`. With no jwt argument it uses getSession(), refreshing the session when the token is about to expire. Current versions: @supabase/supabase-js 2.117.1, @supabase/ssr 0.12.7.

Source: https://www.npmjs.com/package/@supabase/auth-js (package source src/GoTrueClient.ts, v2.117.1, inspected via npm pack) · confidence: verified-official-doc

### Q6: Exact SQL bodies of auth.uid(), auth.role(), auth.email() in the Supabase Auth migrations. The template namespace is 'auth'. **(load-bearing)**

create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
auth.role() and auth.email() follow the same pattern with 'request.jwt.claim.role' / ->> 'role' (returns text) and 'request.jwt.claim.email' / ->> 'email' (returns text). The hosted EXPLAIN output in the RLS performance doc shows the same body: COALESCE(NULLIF(current_setting('request.jwt.claim.sub'::text, true), ''::text), ((NULLIF(current_setting('request.jwt.claims'::text, true), ''::text))::jsonb ->> 'sub'::text)))::uuid

Source: https://raw.githubusercontent.com/supabase/auth/master/migrations/20220224000811_update_auth_functions.up.sql · confidence: verified-official-doc

### Q6: Exact SQL body of auth.jwt(). The same migration marks uid(), role() and email() as deprecated in function comments. **(load-bearing)**

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
comment on function auth.uid() is 'Deprecated. Use auth.jwt() -> ''sub'' instead.' A local test shim therefore needs roles anon/authenticated/service_role, schema auth, these 4 functions, and `set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', true);`. Supabase testing docs use the same approach: "set local role authenticated;" plus setting "request.jwt.claims". auth.uid() returns null when unauthenticated. Wrap it as (select auth.uid()) for per-statement caching.

Source: https://raw.githubusercontent.com/supabase/auth/master/migrations/20220531120530_add_auth_jwt_function.up.sql ; https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/database/postgres/row-level-security.mdx · confidence: verified-official-doc

### Q7: Connection strings: direct 5432 (IPv6), shared pooler in session mode 5432 and transaction mode 6543 (IPv4). The shared pooler username is postgres.<ref>. Transaction mode does not support prepared statements. **(load-bearing)**

Direct: postgresql://postgres:[PW]@db.[REF].supabase.co:5432/postgres. Session: postgresql://postgres.[REF]:[PW]@[POOLER-HOST]:5432/postgres. Transaction: postgresql://postgres.[REF]:[PW]@[POOLER-HOST]:6543/postgres. Dedicated pooler: postgresql://postgres:[PW]@db.[REF].supabase.co:6543/postgres. Pooler host: aws-[INDEX]-[REGION].pooler.supabase.com, where INDEX must come from the Dashboard. Serverless advice: create the client at module scope, pool size 1 per instance, disable prepared statements ("Transaction mode does not support prepared statements"), require SSL. Rendered page: https://supabase.com/docs/guides/database/connecting-to-postgres

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/database/connecting-to-postgres.mdx · confidence: verified-official-doc

### Q7: Drizzle documents postgres-js with prepare:false for Supabase transaction pooling, plus an RLS wrapper. The wrapper opens a transaction, sets request.jwt.claims and request.jwt.claim.sub with set_config(..., TRUE), runs `set local role`, and resets everything in finally. **(load-bearing)**

const client = postgres(process.env.DATABASE_URL, { prepare: false }); const db = drizzle({ client });
The RLS wrapper runs inside client.transaction(async (tx) => ...):
await tx.execute(sql`
  select set_config('request.jwt.claims', '${sql.raw(JSON.stringify(token))}', TRUE);
  select set_config('request.jwt.claim.sub', '${sql.raw(token.sub ?? "")}', TRUE);
  set local role ${sql.raw(token.role ?? "anon")};
`);
return await transaction(tx);
finally: select set_config('request.jwt.claims', NULL, TRUE); select set_config('request.jwt.claim.sub', NULL, TRUE); reset role;
drizzle-orm@0.45.3 exports from 'drizzle-orm/supabase': anonRole, authenticatedRole, serviceRole, postgresRole, supabaseAuthAdminRole, authUsers, realtimeMessages, authUid (= sql`(select auth.uid())`), realtimeTopic. Rendered pages: https://orm.drizzle.team/docs/rls and https://orm.drizzle.team/docs/connect-supabase (orm.drizzle.team is blocked here, so this was read from the docs repo).

Source: https://raw.githubusercontent.com/drizzle-team/drizzle-orm-docs/main/src/content/docs/pg/rls.mdx ; https://raw.githubusercontent.com/drizzle-team/drizzle-orm-docs/main/src/content/docs/pg/connect-supabase.mdx · confidence: verified-official-doc

### Q8: The Spend Cap is available only on the Pro plan and is on by default. With it on, usage beyond quota is blocked until the next billing cycle and nothing is charged. Compute is NOT covered. **(load-bearing)**

Billing FAQ: "The Pro Plan has a Spend Cap enabled by default to keep costs under control." Covered: Disk Size, Egress, Edge Function Invocations, Logs Ingest, Logs Query, MAU, Monthly Active SSO/Third Party Users, Realtime Messages, Realtime Peak Connections, Storage Image Transformations, Storage Size. NOT covered: Compute, Branching Compute, Read Replica Compute, Custom Domain, extra Disk IOPS/Throughput, IPv4 address, Log Drain Hours/Events, MFA Phone, PITR. Toggle it in Organization > Billing > Cost Control. Rendered page: https://supabase.com/docs/guides/platform/cost-control

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/platform/cost-control.mdx ; https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/platform/billing-faq.mdx · confidence: verified-official-doc

### Q8: Micro compute costs $0.01344/hour (about $10/month) with shared CPU and 1 GB RAM. Paid plans include $10/month of Compute Credits, which cover one Micro project.

"Paid plans include $10 in Compute Credits, which cover one project running on the Micro/Nano Compute size or portions of other Compute sizes." Credits reset monthly and do not accumulate. "In paid organizations, Nano Compute are billed at the same price as Micro Compute." The doc's example bill includes a $25 Pro Plan fee, so one Micro project on Pro comes to about $25/month before usage overages. Rendered pages: https://supabase.com/docs/guides/platform/compute-and-disk and .../manage-your-usage/compute

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/platform/compute-and-disk.mdx ; https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/platform/manage-your-usage/compute.mdx · confidence: verified-official-doc

### Q8: Backups run daily on Pro (7 days kept), Team (14 days) and Enterprise (up to 30). The Free plan gets no automatic backups. Storage objects are NOT in database backups. **(load-bearing)**

"We automatically back up all Pro, Team, and Enterprise Plan projects on a daily basis." Pro keeps the "last 7 days of daily backups". "Database backups do not include objects you store via the Storage API, as the database only includes metadata about these objects." The PITR add-on needs at least Small compute, and daily backups stop once PITR is on. Free plan: use `supabase db dump`. Rendered page: https://supabase.com/docs/guides/platform/backups

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/platform/backups.mdx · confidence: verified-official-doc

### Q9: RLS policies on storage.objects, scoped by bucket_id and per-user folder. In a private bucket every operation goes through RLS. **(load-bearing)**

create policy "Allow authenticated uploads" on storage.objects for insert to authenticated with check ( bucket_id = 'my_bucket_id' and (storage.foldername(name))[1] = (select auth.jwt()->>'sub') );
create policy "Individual user Access" on storage.objects for select to authenticated using ( (select auth.jwt()->>'sub') = owner_id );
Upload needs INSERT. Upsert needs SELECT + INSERT + UPDATE. Private bucket: "all operations are subject to access control via RLS policies". Downloads use the user's JWT or a signed URL (createSignedUrl(path, expiresIn), which needs objects `select`). A new helper appears in the docs: storage.allow_any_operation(array['object.get_authenticated_info','object.get_authenticated']). Rendered page: https://supabase.com/docs/guides/storage/security/access-control

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/storage/security/access-control.mdx ; https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/storage/buckets/fundamentals.mdx · confidence: verified-official-doc

### Q9: createSignedUploadUrl(path, { upsert? }) returns { signedUrl, token, path }. The URL is valid for 2 hours, and creating it needs INSERT on storage.objects. uploadToSignedUrl(path, token, file) needs no RLS permissions. **(load-bearing)**

storage-js 2.117.1: "Signed upload URLs can be used to upload files to the bucket without further authentication. They are valid for 2 hours." It calls POST ${url}/object/upload/sign/${bucket/path}, and upsert sends header 'x-upsert: true'. Example signedUrl: https://example.supabase.co/storage/v1/object/upload/sign/avatars/folder/cat.jpg?token=<TOKEN>. RLS: createSignedUploadUrl needs objects `insert`; uploadToSignedUrl needs none; createSignedUrl needs `select`. Client: supabase.storage.from('bucket').uploadToSignedUrl('folder/cat.jpg', token, file).

Source: https://www.npmjs.com/package/@supabase/storage-js (package source src/packages/StorageFileApi.ts, v2.117.1, inspected via npm pack) · confidence: verified-official-doc

### Q10: Current @supabase/ssr setup for the Next.js App Router uses lib/supabase/client.ts, lib/supabase/server.ts, lib/supabase/proxy.ts (updateSession) and a root proxy.ts on Next.js 16. The env vars are NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. **(load-bearing)**

Docs: "On Next.js 15 and earlier, a `proxy.ts` file is never called ... Next.js renamed this file in version 16." server.ts: `export async function createClient() { const cookieStore = await cookies(); return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll() { return cookieStore.getAll() }, setAll(cookiesToSet, _headers) { try { cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) } catch {} } } }) }`. lib/supabase/proxy.ts updateSession: creates the client with request.cookies, and setAll(cookiesToSet, headers) also copies headers onto the response via supabaseResponse.headers.set. It then calls `const { data } = await supabase.auth.getClaims()` and redirects to /login when there are no claims and the path does not start with /login or /auth. Root proxy.ts: `export async function proxy(request: NextRequest) { return await updateSession(request) }` with matcher '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'. "Always use `supabase.auth.getClaims()` to protect pages ... _Never_ trust `supabase.auth.getSession()` inside server code." The ssr 0.12.7 type SetAllCookies has a second argument carrying the Cache-Control/Expires/Pragma headers.

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/auth/server-side/creating-a-client.mdx ; https://raw.githubusercontent.com/supabase/supabase/master/examples/auth/nextjs/lib/supabase/server.ts ; https://raw.githubusercontent.com/supabase/supabase/master/examples/auth/nextjs/lib/supabase/proxy.ts ; https://raw.githubusercontent.com/supabase/supabase/master/examples/auth/nextjs/proxy.ts · confidence: verified-official-doc

### Q10: The OAuth PKCE callback route is app/auth/callback/route.ts. It calls exchangeCodeForSession(code), sanitizes `next`, and handles x-forwarded-host. **(load-bearing)**

export async function GET(request: Request) { const { searchParams, origin } = new URL(request.url); const code = searchParams.get('code'); let next = searchParams.get('next') ?? '/'; if (!next.startsWith('/')) { next = '/' } if (code) { const supabase = await createClient(); const { error } = await supabase.auth.exchangeCodeForSession(code); if (!error) { const forwardedHost = request.headers.get('x-forwarded-host'); const isLocalEnv = process.env.NODE_ENV === 'development'; if (isLocalEnv) return NextResponse.redirect(`${origin}${next}`); else if (forwardedHost) return NextResponse.redirect(`https://${forwardedHost}${next}`); else return NextResponse.redirect(`${origin}${next}`) } } return NextResponse.redirect(`${origin}/auth/auth-code-error`) }. Sign-in: supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${origin}/auth/callback` } }). Adding queryParams { access_type: 'offline', prompt: 'consent' } returns provider_refresh_token. Google Cloud redirect URI: https://<project-ref>.supabase.co/auth/v1/callback. Scopes: openid, userinfo.email, userinfo.profile. The partial imports createClient from '@/utils/supabase/server'.

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/_partials/oauth_pkce_flow.mdx ; https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/auth/social-login/auth-google.mdx · confidence: verified-official-doc

### Q10: The 'Before User Created' auth hook is available on Free and Pro. It can be a Postgres function or an HTTP endpoint, and it fires for OAuth sign-ups. Returning {} allows the sign-up; returning an error object rejects it. **(load-bearing)**

Hook availability table: Before User Created, Custom Access Token, Send SMS and Send Email are 'Free, Pro'. MFA and Password Verification Attempt are 'Teams and Enterprise'. Payload: { metadata: { uuid, time, ip_address, name: 'before-user-created' }, user: { id, email, phone, app_metadata: { provider, providers }, user_metadata, aud, role, is_anonymous } }. "the user will not be found in Postgres at the time the hook is called." Reject with: { "error": { "http_code": 403, "message": "..." } }. Postgres function signature: public.hook_x(event jsonb) returns jsonb. Grants: grant execute on function public.hook_x to supabase_auth_admin; revoke execute on function public.hook_x from authenticated, anon, public. config.toml: [auth.hook.before_user_created]
enabled = true
uri = "pg-functions://postgres/<schema>/<function>".

Source: https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/auth/auth-hooks.mdx ; https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/auth/auth-hooks/before-user-created-hook.mdx · confidence: verified-official-doc
