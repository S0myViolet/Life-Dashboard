# Personal Home

## Product and implementation handoff for Claude Code

Version 1.0 · 24 September 2026

> This file is the product source of truth, kept verbatim. Implementation changes and
> interpretations are recorded separately in `docs/DECISIONS.md`.

This is the complete starting brief for a private personal dashboard. It incorporates the owner's latest corrections and supersedes earlier conversation drafts. The working name is Personal Home; branding can change later.

Build the application described here in stages. Preserve the full product scope while validating uncertain connections early. Do not turn an unverified integration into a claim that it works. There is no existing application in the planning workspace, and no accounts have been connected, services purchased or integrations tested with the owner's data.

**Main outcome:** I open one calm, attractive home on my phone or laptop and understand what matters, what changed and what I should do today. It should collect information automatically wherever practical, with simple ways to capture the things I choose to log myself.

## 1. Decisions already made

### Owner requirements

- One private user, on iPhone and laptop. Use a hosted, installable web app with persistent sign-in.
- Keep the appearance light, simple and pleasant. Detailed visual design is secondary and can change later. Previously considered dark and pastel-neumorphic references are not approved designs.
- Bring together work, personal projects, calendar, tasks, habits, fitness, money, subscriptions, learning, books, relationships, notes, journaling, email and interests.
- Support multiple Gmail and Outlook accounts and identify important information in their messages.
- Produce an 11 a.m. briefing and a 10 p.m. project review. Hosted jobs must run with the laptop closed.
- Suggest a realistic plan for today, including three priorities, a proposed order/time slots, small tasks and what can wait.
- Collect ongoing ChatGPT and Claude project updates without daily copying, pasting or exporting. A Chrome helper and catching up when the laptop/browser is open are acceptable.
- Use WHOOP for fitness. Use Revolut and HSBC UK for banking, subject to actual account compatibility.
- Use Spotify listening activity to identify relevant artists. The owner has Premium. Following an artist alone is not evidence that the owner listens to them.
- Keep Financial news, Markets, AI updates, Liverpool, Premier League, Champions League and Music as separate configurable sections.
- Let the owner add interests and sources, hide/reorder sections and change preferences as the platform grows.
- Reading progress will be logged manually. Notes are freeform typed entries. Journaling supports voice, editable transcription, text and optional prompts.
- Default alerts: the two briefings plus urgent/time-sensitive items and user-set reminders. Other interest alerts are opt-in.
- Operating budget: no more than £75/month, excluding the existing Claude Code subscription. Use inexpensive AI with explicit spending controls.
- Useful fallback states are acceptable for unsupported services. Manual project updates do not satisfy the automatic AI-conversation requirement.

### Explicit exclusions

- Remove Quranly and Duolingo entirely from integration scope. Duolingo was an example, not an app the owner uses.
- No mood tracking.
- No assumption that a web app can enumerate all installed iPhone apps, read their private data or continuously monitor the phone screen.
- No automatic emails/messages, bank transfers, trades, subscription cancellations or external calendar changes in v1.
- No public signup, social features, team workspaces, monetization or native iPhone app.
- No drawing canvas in the initial sketchbook. Start with text, lists and links.

### Chosen engineering defaults

The stack, navigation labels, data retention, sync intervals, AI sub-budget and planner rules below are implementation defaults, not statements about the owner's existing habits. Use them without another architecture questionnaire. Collect account credentials and personal configuration through setup when needed.

## 2. Screens and navigation

Desktop uses a compact sidebar. Mobile uses Home, Plan, Capture, Updates and More in bottom navigation. More opens Projects, Money, Health, Learning, People and Settings. Keep modules discoverable without putting every card on the home screen.

### Home

Show the date and a short greeting, followed by:

1. Needs attention: explicit deadlines, overdue tasks and time-sensitive messages.
2. Your plan for today: three priorities and the next suggested action.
3. Today's calendar, tasks and habits, with a link to the week.
4. Latest briefing and project changes.
5. Small health/money previews and selected interest cards.
6. Persistent quick capture: task, note, journal recording or reading log.

Let the owner reorder and hide optional modules. Keep information density moderate: preview a few items with a clear route to the complete list. Do not block the home screen on every provider or AI request; load saved content first and refresh sections independently.

### Plan

Provide day/week calendar views, local tasks, recurring habits and daily-plan suggestions. External calendar events are read-only with links to their original service. Local tasks support title, project, due date/time, priority, optional duration, status and reminder. Habits support selected weekdays, completion and history.

### Projects

Support work and personal projects with a goal, status, linked chats, notes, tasks, recent progress, open questions and next-action suggestions. Each imported claim has a source link and capture time. AI suggestions remain separate from confirmed tasks until accepted.

### Capture

Provide searchable notes and a journal. Notes can be linked to a project, date, book or person. Journal entries support typing or recording, then editable transcription. Optional prompts: what happened, what moved forward, what needs attention and what to do next. Do not add mood scores.

Autosave drafts and show whether they are saved locally or synced. Support recovery after recording/upload/transcription failure. Handle microphone denial and the actual audio formats supported by iPhone Safari and desktop Chrome.

### Money, Health, Learning and People

| Area | Required behavior |
|---|---|
| Money | Account balances in their original currency, recent transactions, recurring-payment/subscription candidates, renewal dates and editable categories. Do not add balances in different currencies without a stated conversion source; v1 can group by currency. |
| Health | WHOOP sleep, recovery, strain and workouts with dates and source freshness. Keep this a personal overview; do not infer medical diagnoses. |
| Learning | Reading list, manually entered reading progress, learning goals and practice habits. Support pages or percentage per book without requiring both. |
| People | Manually managed people, notes, important dates and reminders to catch up. No automatic contact scraping or relationship scoring. |

### Updates and interests

Create these seven distinct sections by default:

| Section | Contents |
|---|---|
| Financial news | Business/economic headlines and selected financial topics, with publisher, publication time and original article link. |
| Markets | A market overview and editable symbol watchlist. Keep price/chart data separate from news articles and from personal bank balances. |
| AI updates | Model/tool releases, product changes and research/product news from selected sources. |
| Liverpool | Club news and available Liverpool fixtures/results. |
| Premier League | Competition fixtures/results, standings and news. |
| Champions League | Competition fixtures/results, current competition structure/standings and news. Do not hardcode an outdated group-stage format. |
| Music | Albums/singles from the owner's listening-based artist list, artwork, release dates and Open in Spotify. |

Use one underlying record for an item relevant to several sections, so Liverpool matches can appear under Liverpool and the appropriate competition without duplicate alerts. Offer save, dismiss, mute source and section settings.

### Settings and first-run setup

Set up the owner account, timezone, connected accounts, calendar selection, optional available hours, interest sources, artist controls, notification preferences, data export/deletion and budget/status screens. Default the timezone from the device, display it for confirmation, then keep it stable until explicitly changed.

Connections are added individually; the dashboard remains useful with none connected. Do not make onboarding a long mandatory questionnaire.

## 3. Your plan for today

This is a core feature, not just a summary of the calendar.

Inputs: local tasks and durations, accepted project actions, calendar commitments, explicit deadlines extracted from email, due habits, reading goals and the owner's stated availability. WHOOP may offer optional context, but must not automatically cancel commitments or dictate health decisions.

Use these rules:

- Generate a draft on first use each local day, from saved data; refresh the proposal with the 11 a.m. briefing. Provide a Plan my day / Replan remaining day button.
- Pick up to three priorities. Prefer explicit urgent deadlines, overdue tasks, user priorities and agreed project actions. Explain briefly why each was selected.
- Keep suggestions based on unconfirmed email/project inferences visibly tentative. Do not silently create tasks from every message.
- Fit proposed tasks around busy calendar events and already accepted plan blocks. Respect the current time: do not put a new task into an elapsed slot.
- Use the owner's available hours if set. If absent, suggest an ordered list and estimated effort without inventing a working schedule.
- Use entered durations when available. Otherwise label a suggested estimate, defaulting to 30 minutes, and let the owner change it.
- Leave approximately 20% of available time unallocated. Split work only when the task is marked splittable. Clearly show items that do not fit.
- Include small tasks for short gaps and a Can wait list; do not claim everything is achievable.
- Let the owner accept, edit, reorder, pin or dismiss suggestions. Acceptance creates local plan blocks only.
- Preserve accepted/pinned blocks and manual changes. Later data changes produce a proposed revision or conflict notice, never a silent replacement.

Use deterministic scheduling/validation for times and conflicts; AI can rank supported candidates and explain suggestions. At the AI limit, build a basic plan from deadlines, priorities and duration using the same validation rules.

## 4. Integration design

Every connection needs separate status, last attempt, last successful sync, error/reconnect state and source links. Distinguish when something happened from when it was collected. Empty, unavailable, partially synced and no new activity are different states.

### Gmail and Outlook

Connect each account separately with read-only delegated OAuth. Initial import: the last 90 days of normal mail plus a targeted search over 12 months for receipts, billing and renewals. Exclude spam/trash and preserve partial-import status while processing pages.

After initial import, poll every 15 minutes using incremental cursors. Cover user folders as well as Inbox so mail rules do not hide receipts. Identify action requests, explicit deadlines, important updates and subscription candidates. Store evidence and editable confidence; an old receipt alone does not prove an active subscription.

- Google: Gmail readonly, calendar-list readonly and calendar-events readonly; request calendar access when enabled. Use server authorization-code flow with offline access. Configure the private personal-use OAuth project as External / In Production, not Testing. Personal use has a verification exception; the consent warning may remain. [Google verification exception](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification#exceptions_to_verification_requirements), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [OAuth lifecycle](https://support.google.com/cloud/answer/15549945?hl=en).
- Microsoft: confidential Web application supporting personal and organizational accounts; delegated identity scopes plus offline_access, Mail.Read and Calendars.Read. Keep token exchange/cache on the server. Organizational policies can still require an administrator. [Microsoft permissions](https://learn.microsoft.com/en-us/graph/permissions-reference), [refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens).
- Save Gmail historyId, Google Calendar syncToken and Microsoft delta links at the correct account/folder/calendar level. Follow all pages; resync on expired cursors. Calendar windows must advance and resync without losing future events. [Gmail sync](https://developers.google.com/workspace/gmail/api/guides/sync), [Google Calendar sync](https://developers.google.com/workspace/calendar/api/guides/sync), [Microsoft mail delta](https://learn.microsoft.com/en-us/graph/delta-query-messages).

Users can correct importance and dismiss inferred commitments. Provide links to original messages; v1 does not send, archive or mark mail read.

### ChatGPT and Claude project collection

Build a private Chrome Manifest V3 extension, locally loadable for the owner, with an authenticated connection to the dashboard.

1. Select a conversation once and attach it to a project. Capture messages automatically when it loads or changes.
2. Prototype background revisits of selected conversation URLs every 30 minutes while Chrome is running, using a bounded queue and at most one collector tab per service. Keep browser activity visible and pausable.
3. Capture rendered user/assistant text, conversation identity/link, message identifiers when available, capture time and coverage status. Do not claim attachment contents, hidden messages or full history that was not actually collected.
4. Catch up on wake/browser startup. A phone update can be collected later if it appears in the same account's web conversation; verify this with real sessions.
5. Reconcile new/edited messages without duplicating summaries. Never replace a fuller stored snapshot with an incomplete page scrape or treat missing rendered content as proof of deletion.
6. If signed out or the page structure changes, pause that connection, retain last-good data and show Reconnect / Capture needs attention.

Chrome can read permitted page DOM, but this is not a verified consumer chat-history API. Selection of individual chats is the baseline. Automatic discovery of every new chat in a project folder is an optional later enhancement, not a v1 dependency. Do not build against invented ChatGPT/Claude history endpoints. [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs), [sleep behavior](https://developer.chrome.com/docs/extensions/reference/api/alarms).

**Early gate:** prove changed messages, long conversations, edited messages, later web visibility of phone updates and startup catch-up on both services. Respect service access controls; do not bypass login challenges or harvest session cookies. If reliable background revisits fail, report exactly what works and what remains blocked. Routine copy/paste is not an acceptable substitute for this requirement. Continue independent dashboard work while resolving the limitation.

### Banking and subscriptions

Use Lunch Flow's Personal API for the owner's accounts. Validate the exact Revolut UK and HSBC UK Personal account types during its trial before treating banking as connected. Read accounts, balances and transactions; no payments.

The published monthly plan is £4.99 with four connections. UK refresh is approximately daily, so preserve provider timestamps and do not imply live balances. Verify checkout price and account coverage before purchase. [Personal API](https://www.lunchflow.app/docs/api/personal-api-overview), [pricing](https://www.lunchflow.app/docs/guides/account/pricing), [UK connection guide](https://www.lunchflow.app/docs/guides/connections/regions/uk-eu).

Combine email evidence and recurring transaction patterns into subscription candidates. Let the owner confirm merchant, amount/currency, billing interval, next renewal and active/cancelled status. Show unknown when a fact is missing. Match provider transaction IDs and receipt evidence to avoid double counting. CSV import with a preview, column mapping and duplicate detection is the fallback for unsupported bank accounts.

### WHOOP

Use official OAuth and the v2 API for recovery, cycles, sleep and workouts. Start with hourly incremental polling and reconnect handling; webhooks can be added later if needed. Show unscored/pending data as pending rather than zero. Do not add an Apple Health native bridge. WHOOP's small-user development access is appropriate for this personal app, subject to setup verification. [WHOOP API](https://developer.whoop.com/api/), [app approval](https://developer.whoop.com/docs/developing/app-approval/).

### Spotify: artists actually listened to

Use the owner's Premium developer account and allowlist their Spotify user. Seed Artists I listen to from Spotify's short- and medium-term top-artist results, up to 50 each, then deduplicate. Do not seed from followed artists or trending recommendations. Request user-top-read; optionally supplement with recent plays using user-read-recently-played. These sources do not promise complete listening history. [Top artists](https://developer.spotify.com/documentation/web-api/reference/get-users-top-artists-and-tracks), [recent plays](https://developer.spotify.com/documentation/web-api/reference/get-recently-played), [development access](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

Refresh daily. Let the owner pin an artist or mute one permanently; preserve those edits. Use GET /artists/{id}/albums with album,single and paginate at the current allowed page size. Cache results and pace jobs; do not assume the first page is chronologically complete. Deduplicate collaborative releases by release ID, preserve date precision and avoid a notification flood on first sync. Empty listening data gets an honest empty state and an artist picker. [Artist releases](https://developer.spotify.com/documentation/web-api/reference/get-an-artists-albums), [2026 endpoint changes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026).

Keep this integration deterministic. Do not send Spotify content, artist metadata, listening records or artwork into AI prompts, embeddings or summaries. Do not create custom listening profiles or play-count analytics. Render music cards and optional briefing inserts after AI generation, with Spotify attribution and direct links. On disconnect, delete Spotify personal data and stop collection. [Spotify Developer Policy](https://developer.spotify.com/policy).

### Football

Use football-data.org for supported Liverpool matches, Premier League and Champions League fixtures/results/standings. Resolve current team/competition IDs through the API instead of guessing them. Free-tier scores and schedules are delayed; label this. Refresh upcoming fixtures/standings every six hours and relevant match-day results every 15 minutes within quota. Preserve actual competition phase data. Cup competitions outside coverage are labelled unavailable with an official source link, not silently omitted as if no match exists. [Pricing](https://www.football-data.org/pricing), [coverage](https://www.football-data.org/coverage).

News is a separate source stream. A match can have multiple topic tags but produces one notification.

### News and market overview

Implement a configurable RSS/Atom reader refreshed hourly, with per-source topic tags, source timestamps, deduplication, mute controls and links to full articles. Process feed-provided excerpts; do not bypass paywalls or infer an article's contents from its headline.

Seed a source catalog around BBC Business, BBC Sport/Liverpool and official AI/company release blogs, plus official Liverpool, Premier League and UEFA news pages. During setup/implementation, validate publisher-provided feed URLs or advertised feed discovery. A page with no supported feed remains a labelled source shortcut; do not invent an RSS endpoint or claim automated coverage. Allow additional feed URLs. Validate URLs and block private/local network destinations in the fetcher.

For Markets, the v1 default is an official TradingView market-overview/watchlist widget, preserving attribution and provider instrument/delay labels. Let the owner configure supported symbols. Do not relabel CFDs as underlying indices or infer holdings from a watchlist. This keeps market display within budget. [Widget overview](https://www.tradingview.com/widget/), [market overview](https://www.tradingview.com/widget-docs/widgets/watchlists/market-overview/).

Isolate the widget in a sandboxed embed so vendor scripts cannot access authenticated app data. Pass only public symbol configuration. If the provider blocks a symbol/embed, show a source link and unsupported state. Widget data is display-only: do not scrape it or claim an API for ingestion into the briefing/chat. Financial-news summaries can still use permitted feed content. [Widget data limits](https://www.tradingview.com/widget-docs/faq/data/).

## 5. Briefings, chat and notifications

At 11:00 local time, publish important email, today's commitments, the proposed daily plan, project priorities and upcoming renewals. At 22:00, publish project progress, unresolved questions, suggested next actions and optional journal prompts. Evening suggestions can inform tomorrow's draft without changing accepted tasks.

Prepare from cached sources and attempt a refresh shortly before publication. Do not wait indefinitely for one provider. Show source freshness and omitted/unavailable connections. Music inserts use deterministic rendering outside the AI path.

Provide dashboard chat with read-only retrieval over eligible connected data, notes, tasks and summaries. Answers link to evidence and admit missing/stale context. Spotify content and embedded market quote data are excluded from model input. Chat may offer a local task/plan draft for the owner to accept; it does not execute external actions.

Default notifications:

- The 11 a.m. briefing and 10 p.m. review.
- User-created reminders and verified explicit deadlines approaching within 24 hours. AI uncertainty alone must not trigger an urgent alert.
- Interest alerts are off until enabled by section.
- Dedupe repeated items; do not alert for every backfilled email, old album or resynced match.
- Use generic lock-screen text by default; detailed email, financial and journal content appears after opening the app.

Use standards-based Web Push and an in-app notification inbox. On iPhone, guide Add to Home Screen and request notification permission only from an explicit Enable notifications action. Denial does not block the app. Push delivery time is subject to device/network behavior. [WebKit guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## 6. Architecture and interfaces

Use a pnpm TypeScript workspace:

| Component | Choice |
|---|---|
| Web app | Next.js App Router, TypeScript, Tailwind; responsive PWA |
| Hosting | Vercel Hobby for this personal noncommercial app |
| Backend | One Supabase Pro Micro project: Postgres, Auth, private Storage and Edge Functions |
| Background jobs | Supabase Cron and pg_net invoking authenticated Edge Functions |
| Chrome helper | Manifest V3, TypeScript and a small build setup; separate app in the workspace |
| Validation and tests | Shared runtime validation, Vitest for domain behavior, Playwright for user flows |

Suggested layout: apps/web, apps/extension, packages/core, supabase/migrations and supabase/functions. Install current supported package versions, record them in the lockfile and document the runtime. Do not add microservices, a vector database or a workflow SaaS before there is a concrete need.

Use Supabase Google sign-in restricted to a preconfigured owner email/verified identity through a server-side allowlist. Enforce owner membership in RLS and storage rules as well as UI routing. Connecting a second mailbox must not change the authenticated dashboard owner. Keep integration consent separate from app sign-in.

### Minimum data groups

- Owner settings, timezone, module layout and notification preferences.
- Connections, encrypted tokens, sync cursors and status.
- Source records and activity items with provider/external ID, original URL, source time, fetch time and coverage.
- Projects and conversation associations; captured message versions and derived summaries.
- Tasks, habits/completions, calendar events, daily plans and accepted plan blocks.
- Notes, journals, books/reading logs, people and reminders.
- Bank accounts/transactions, subscription candidates, confirmed subscriptions and evidence links.
- Interest sections, feed sources, items, music selection overrides and market symbol configuration.
- Scheduled jobs, briefing records, delivery attempts and AI usage reservations.

Keep provider-specific fields in adapters, not scattered through screen components. Use stable external identities for deduplication and keep imported facts, inferred suggestions and user corrections distinct.

### Required boundaries

- Connection adapters expose authorize, refresh, sync, status and disconnect behavior. The shared scheduler supplies account identity and saved cursors.
- A versioned capture endpoint accepts extension ID/token, provider, conversation ID/URL, messages, capture timestamp and coverage. Pair the extension through an authenticated one-time code; hash revocable capture tokens and restrict their scope to the owner's selected conversations. Validate origins, URLs, payload size and deduplication keys. No app/admin secrets in the extension.
- User-facing reads/writes use authenticated, owner-scoped application routes or Supabase policies. Internal job invocation has separate authentication; a public Supabase key alone is not sufficient.
- The planner accepts candidates, calendar busy periods, availability and protected plan blocks, then returns validated suggestions and conflicts.
- The AI gateway accepts only permitted source types, reserves budget, makes a bounded request and records actual usage. Apply source restrictions before constructing prompts.

## 7. Scheduling, reliability and privacy

Run a minute dispatcher that claims due jobs with leases in Postgres. Store next run, attempts, backoff, cursors and last success. Jobs must be resumable and idempotent; parallel workers must not process the same lease.

Calculate schedules using the saved IANA timezone and UTC execution times. A unique owner/type/local-date key prevents duplicate briefings across retries and timezone/DST transitions. Publish overdue briefings with a late label after an outage; do not send a backlog of old push notifications.

Avoid Vercel Hobby Cron for briefing timing. Supabase supports scheduled Edge calls; keep work I/O-heavy and chunked to respect function wall-time/CPU/memory limits. [Supabase scheduling](https://supabase.com/docs/guides/functions/schedule-functions), [function limits](https://supabase.com/docs/guides/functions/limits), [Vercel Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Honor provider rate limits and Retry-After. Isolate failures by account. Never replace old valid data with a fabricated zero, empty balance or no-events claim.

Security and retention defaults:

- Encrypt refresh tokens with a server-held key; keep vendor secrets in server configuration. Never log credentials, mail bodies, journal text or complete captured conversations.
- Treat imported mail, chats and articles as untrusted data. They cannot change system instructions, invoke external actions or choose exfiltration URLs.
- Retain raw imported mail/chat text for 30 days by default; retain useful derived summaries and provenance until deleted. Keep notes, journals and accepted tasks until the owner deletes them. Explain these defaults in Settings.
- Delete recordings after successful transcription is saved. Keep failed recordings in private storage for up to seven days, with retry/download/delete actions and a visible expiry.
- Pause/reconnect is distinct from disconnect. Disconnect stops jobs, revokes/deletes tokens and removes imported provider data and derived summaries; explicitly accepted local tasks/notes can remain with a source-removed marker. Apply Spotify's deletion requirement.
- Support owner export as JSON plus Markdown for notes/journals. Deletion also removes linked summaries/search entries and queued jobs; document backup retention.
- Use daily database backups and verify restore. Supabase database backups exclude Storage objects; any retained uploads need an explicit export/backup path. [Supabase backups](https://supabase.com/docs/guides/platform/backups).

For offline use, cache the shell and explicitly saved drafts rather than entire inbox/bank responses. Clear local caches on logout. Show pending writes and resolve conflicts without losing edited notes.

## 8. AI and running costs

Default to the paid Gemini API with configurable model IDs:

- gemini-3.5-flash-lite for extraction, grounded summaries, explanations and dashboard chat.
- gemini-3.5-transcribe for recorded journal transcription.

These model IDs were checked against the official catalog on the document date. Recheck availability/pricing at implementation; if a model changes, report the replacement and preserve the budget/data-processing constraints. Paid-tier content is stated not to be used to improve Google's products. [Model catalog](https://ai.google.dev/gemini-api/docs/models), [pricing](https://ai.google.dev/gemini-api/docs/pricing).

Use incremental processing, deduplicated source hashes, bounded prompts/outputs and cached summaries. Do not resend whole mailboxes or entire chat histories for every brief. Start with Postgres full-text search and structured retrieval; embeddings are unnecessary for v1.

Allocate £15/month to AI and transcription. Before a request, atomically reserve a conservative maximum cost, including output/thinking tokens or audio duration. Set explicit request limits, reconcile against returned usage and preserve reservations for ambiguous failures until reconciled. Track provider currency with a conservative configurable GBP conversion; warn at 80%. At the cap, stop new model calls. Continue sync, deterministic planning, templates, saved summaries and ordinary personal tools.

| Monthly allowance | Amount |
|---|---:|
| Supabase, including currency/tax margin | £30 |
| Vercel Hobby | £0 |
| Lunch Flow | £5 |
| AI and transcription | £15 |
| Domain allowance | £2 |
| Headroom for tax/FX/provider changes | £23 |
| Total ceiling | £75 |

These are allowances, not exact invoices. Start with free football/news feeds and the free branded market widget. Enable Supabase's spend cap, use one Micro instance and no paid branches/add-ons. The provider cap does not cover every possible compute/add-on purchase, so do not describe it as a universal £75 guarantee. Show configured recurring cost and measured AI usage in Settings. Do not purchase an optional service automatically. [Supabase pricing](https://supabase.com/pricing), [cost controls](https://supabase.com/docs/guides/platform/cost-control), [Vercel Hobby](https://vercel.com/docs/plans/hobby).

## 9. Build sequence

### Milestone 0 — Establish the foundation and prove hard dependencies

Read this brief and inspect the target repository. Scaffold the workspace, shared types, local database, owner authentication, job framework and a minimal Home/Connections interface. Keep demo fixtures isolated from real-account mode.

Build the smallest Chrome capture prototype for one selected conversation in each service. Test background revisits, edited/long chats, startup catch-up and phone-to-web visibility. Separately configure Gmail/Outlook OAuth and verify token refresh with the browser closed. Validate both bank account types through Lunch Flow when account setup is available.

Create an integration-results document listing proven capabilities, failed checks and missing account setup. Missing credentials block that integration test only; proceed with independent work using adapters and labelled fixtures. Do not label mocked responses as a connected account.

### Milestone 1 — A useful personal home

Finish responsive navigation, local tasks/habits, day/week views, notes, voice/text journal, reading, people and quick capture. Build the daily planner with deterministic conflict checks and edit preservation. Provide usable empty/disconnected states.

### Milestone 2 — Connected email, projects and daily guidance

Complete multi-account email/calendar sync, project capture, summaries, the 11 a.m./10 p.m. jobs, dashboard chat and notifications. Add source evidence, subscription candidates, reconnection and budget controls.

### Milestone 3 — Health, money and interests

Complete WHOOP, verified banking/CSV fallback, listening-based Spotify releases, the three separate football sections, Financial news, Markets and AI updates. Add section/source controls and cross-section deduplication.

### Milestone 4 — Private release

Run acceptance checks, verify export/deletion and restore, test real iPhone installation and notifications, and deploy privately. Provide setup/run/deploy documentation, an example environment file containing names but no secrets, database migrations and a clear remaining-limitations list.

Full v1 is not complete merely because the interface renders. Each requested capability must work, show its approved fallback, or be explicitly listed as unresolved. Automatic project capture remains an unresolved requirement if only manual imports work.

## 10. Acceptance checklist

| Area | Must pass |
|---|---|
| Access | Only the configured owner can read/write via UI, direct API, database policies or storage URLs. Another mailbox connection does not become another dashboard user. |
| Mobile | Clean layouts at narrow iPhone widths and desktop sizes; keyboard/focus access, readable contrast and usable touch targets. PWA installs and reopens with sign-in preserved. |
| Daily plan | Three-or-fewer priorities; no overlaps with busy events or protected blocks; no scheduling in the past; estimated durations labelled; insufficient time shown honestly. Manual changes survive refresh. |
| Capture | One-time chat selection, then new/edited messages arrive without copy/paste. Long/partial pages do not destroy saved context. Sleep/startup catch-up and signed-out states behave honestly. Test both services. |
| Email/calendar | Multiple Google/Microsoft accounts, custom folders, moved mail, deleted/rescheduled events, expired cursors and one failed account among healthy accounts. Verify background refresh after access-token expiry and Google authorization beyond day seven. |
| Briefings | Both local-time schedules run with laptop closed. DST/timezone changes and retries produce one briefing per type/date. Stale/missing sources and late publication are visible. |
| Subscriptions | Old receipt is not asserted active; duplicate email/transaction evidence does not duplicate a subscription; currency and uncertain renewal dates are correctable. |
| Banking/health | Both exact bank accounts verified or labelled unsupported. Provider dates remain visible. WHOOP pending/unscored data is not treated as zero. |
| Spotify | Followed-only artists are not automatically included; listening results are included; muted artists stay muted; collaborative releases dedupe; initial import does not flood alerts; no Spotify content enters AI. |
| Interests | Seven separate sections exist. Liverpool/competition overlap does not double-alert. Delayed scores/quotes are labelled, unavailable symbols have an honest state, source links work. |
| Journal | Recording, editable transcription, microphone denial, failed upload and retry preserve drafts. No mood feature. |
| Budget | Concurrent requests cannot bypass reservations; cap exhaustion stops AI calls while other features work; uncertain failed requests do not immediately release all reserved cost. |
| Privacy | Imported prompt-injection text cannot trigger actions/exfiltration. Tokens never reach browser logs. Disconnect/deletion removes intended source and derived data; exports and restores are tested. |
| Reliability | Rate limits, provider outage, expired login and unavailable AI do not blank unrelated sections or show fabricated data. |

Use focused domain tests for scheduling, deduplication, spending reservations and plan preservation; adapter fixtures for provider failure modes; and end-to-end tests for owner access, capture, daily planning and journal flows. Perform real-account smoke tests only after the owner completes the relevant setup.

## 11. How Claude Code should start

First, read this document and inspect the target repository. Give a short implementation checklist, then begin Milestone 0 and the independent foundation work. Do not restart discovery or ask the owner to choose a stack, repeat their interests or approve each reversible coding step.

Ask for specific account setup only when needed, explaining the exact setting or credential name. Keep secrets in the owner's environment, not in chat, committed files or logs. If a provider limitation changes a required capability, show the evidence and the smallest practical alternatives instead of quietly dropping the feature.

At each milestone, report what works, what was actually tested, what is using fixtures and what needs owner setup. Keep this brief as the product source of truth and record implementation changes separately.
