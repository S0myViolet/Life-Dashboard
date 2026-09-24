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

### D-22 · Background jobs
- The dispatcher Edge Function runs for at most 40 seconds and 20 jobs per call. pg_cron calls it every minute with a 55-second timeout.
- Briefings wait until an owner exists **and** has confirmed their timezone, so no briefing is dated before the dashboard was claimed or computed in the wrong zone.
- After an outage only the latest due briefing of each kind is published, labelled late, with no notification. Older ones are marked superseded rather than published as a backlog.
- Briefing content is an honest skeleton until Milestone 2. It never claims it was "published on schedule" when it wasn't.

### D-23 · AI spending
- Reservations assume USD→GBP at **1.00**, deliberately above the market rate so £ figures are overestimated. The rate is configurable.
- Thinking tokens are billed at the output rate. Every request reserves a separate thinking allowance because providers do not document whether `maxOutputTokens` caps thinking.
- Any HTTP error, timeout or unreadable response is treated as **ambiguous**: the full reservation stays counted until someone reconciles it. Only failures before a connection was made release money. An hourly job marks reservations older than 24 hours as ambiguous; nothing is released automatically.
- Model output may cite only the evidence ids it was given. Links the model invents are removed, which blocks exfiltration through output.

### D-24 · Mail and calendar connections
- In Milestone 0 the 15-minute `sync.google`/`sync.microsoft` jobs only refresh tokens and call an identity endpoint. That proves background access with the laptop closed. Import arrives in Milestone 2.
- The owner can read connection rows but not write them. Every change goes through server code that applies one state machine, so a job result cannot undo a pause, for example.
- Partial Google consent is recorded honestly and offers Reconnect for the missing scopes. Microsoft has no revoke endpoint: disconnect deletes local tokens and links to the account's app-permissions page.

### D-25 · Chrome helper details
- Message identity: ChatGPT uses `data-message-id`, falling back to `data-turn-id`. Claude uses the row position. When no key is available the server derives a content hash key.
- Nothing is deleted because a page did not show it. A message too long to send is left out and counted, never truncated.
- There is one live pairing code at a time, valid for 10 minutes and usable once. The helper's permissions are `storage` and `alarms`, the two chat hosts, and the dashboard host requested at pairing.

### D-26 · What "whole conversation" means
A capture counts as complete only when every message between the first and the last was actually
observed. The helper reports `contiguous` and `missingCount` from the thread positions it saw
(ChatGPT turn wrappers, Claude row indexes and `aria-setsize`). A snapshot without that proof,
including one from an older helper, is never marked complete. The dashboard names any gap,
for example "12 turns not seen".

### D-27 · Pairing and token hardening
- A failed pairing attempt counts only against the live code it names.
- Each source address may fail 10 times in 10 minutes, then receives 429 with `Retry-After`. Addresses are stored only as hashes.
- The device token is stored in Chrome extension storage set to `TRUSTED_CONTEXTS`, so the content scripts on chatgpt.com and claude.ai cannot read it. Pairing refuses to proceed unless that setting succeeded. The token remains unencrypted on disk inside the Chrome profile.
- Text the database cannot store (NUL characters, lone surrogates) is cleaned before saving. A payload that still fails validation gets a 422, which the helper drops instead of retrying.

---

## Milestone 1

### D-30 · Voice recordings are stored in Postgres, not Supabase Storage
Recordings are uploaded in chunks of 1 MB or less, which stays under serverless request-size limits, and stored in `journal_recording_chunks`. That gives them the same owner-only RLS as all other data and includes them in database backups; Storage objects are excluded from backups. A recording is deleted once its transcript is saved. A failed recording is kept for up to seven days with Retry, Download and Delete.

### D-31 · Daily planner
- Only confirmed tasks, project actions and email deadlines that are under real pressure can be priorities. When nothing is pressing, no priorities are invented. Unconfirmed items are scheduled after everything else, shown as tentative, and skipped by "Accept all".
- **List mode** is used when available hours are unset or none apply to that weekday. It shows an ordered list with effort estimates and never invents a schedule.
- A task marked splittable is placed whole if any gap fits it, and otherwise split into parts of at least 15 minutes, labelled "1 of 2". Items under deadline pressure that do not fit go to **Does not fit**. Items without pressure go to **Can wait**.
- A replan never touches accepted, pinned, done, dismissed or owner-edited blocks. The database enforces no overlap between active timed blocks. When data changes, the owner sees a notice and nothing moves until they choose Replan.
- Marking a plan block done also completes the underlying task, once no other part of it is left, or records the habit.

### D-32 · Learning and people
- A reading log records one measure: page reached, pages read, a percentage or minutes. Percentages are shown only when they can be derived, and they are rounded down so a book is never shown as finished early. Logging on a want-to-read or paused book marks it as reading. Nothing is marked finished automatically.
- A 29 February date is shown on 28 February in non-leap years. A catch-up cadence counts from the day it is set, not "due immediately".

### D-33 · Tasks, habits and reminders
- A timed task keeps its instant. A date-only task follows the owner's calendar date. A timed task becomes overdue once its time passes; a date-only task becomes overdue from the next local day.
- On a daylight-saving change, a time that does not exist moves forward, and a time that occurs twice uses the first occurrence. The owner is told in both cases.
- Unconfirmed tasks (suggestions from email or chat, Milestone 2) stay out of task lists and out of Needs attention until accepted.
- Streaks count scheduled days only. A scheduled day that passed without a check-off shows as **missed**; it is never hidden. An extra check-off on an unscheduled day is shown but does not affect the streak.
- Recurring reminders keep the same local time and day of month through clock changes and short months. Missed occurrences are skipped, not replayed. Reminders are in-app until Web Push arrives in Milestone 2.

### D-34 · Notes, journal and drafts
- There is **one journal entry per day**, in the owner's timezone. Typing, prompt answers and recordings for that day all go into it. The four prompts are optional, and the schema rejects anything else, including mood fields.
- **A recording is deleted only after its transcript is saved.** "Saved" means the owner has reviewed the draft transcript and added it to the entry; the recording is deleted in the same transaction. Every recording's expiry is fixed at 7 days when it is created, and retries never extend it. A daily job deletes expired recordings.
- An iPhone `audio/mp4` recording is relabelled as the documented `audio/m4a` type. If the provider still rejects it, the owner sees a specific message and the recording is kept. A transcript is never invented.
- Notes save with an optimistic version check. A change made on only one side merges automatically. When both sides changed the same field, the owner chooses between this device's version, the saved version, or a prefilled merge.
- Drafts live in IndexedDB until synced. Their status shows as *Saved on this device*, *Synced* or *Waiting to sync*, and signing out clears them.
- Search uses Postgres full-text search: every word must match, words match as prefixes, and there is no stemming. Searches are sent as POST requests, so search words never appear in URLs or access logs.
