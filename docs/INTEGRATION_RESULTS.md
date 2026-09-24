# Integration results

_Last updated 24 September 2026 · Milestone 0_

What each connection can actually do today, how that was established, and what is still needed.
Nothing below counts as **working** unless it was exercised against the real provider. The build
environment can reach package registries only, so no provider has been called from it yet.

## Status key

| Label | Meaning |
|---|---|
| **Verified live** | Exercised against the real service with the owner's account. |
| **Verified locally** | Real code paths tested against real Postgres, a real browser or a real runtime, with the provider replaced by labelled synthetic fixtures. |
| **Built · awaiting setup** | Implemented and tested locally; the next step needs an account, key or console setting from the owner. |
| **Unverified** | A published fact the build relies on that could not be confirmed. |
| **Not started** | Planned for a later milestone. |

## At a glance

| Integration | Status | What the owner needs to do next |
|---|---|---|
| Owner sign-in (Google via Supabase) | Built · awaiting setup | Create the Supabase project and enable the Google provider ([Setup §1–2](SETUP.md)) |
| Background jobs (pg_cron → dispatcher) | Built · awaiting setup | Deploy the function and run the one-time cron script ([Setup §3](SETUP.md)) |
| ChatGPT capture (Chrome helper) | Built · awaiting setup | Load the helper, pair it, run the live checks below ([Setup §7](SETUP.md)) |
| Claude capture (Chrome helper) | Built · awaiting setup | Same as ChatGPT |
| Gmail + Google Calendar | Built · awaiting setup (access check only) | Google Cloud OAuth client, In production ([Setup §4](SETUP.md)) |
| Outlook mail + calendar | Built · awaiting setup (access check only) | Azure app registration, Web platform ([Setup §5](SETUP.md)) |
| Revolut UK / HSBC UK via Lunch Flow | Client built · coverage **unverified** | Start the Lunch Flow trial and run `scripts/verify-lunchflow.mjs` |
| Gemini (AI + transcription) | Built · awaiting setup | Paid-tier API key ([Setup §6](SETUP.md)) |
| WHOOP, Spotify, football-data.org, RSS, TradingView | Not started (Milestone 3) | Nothing yet |

---

## ChatGPT and Claude capture — the brief's early gate

The brief asks for five things to be proven on **both** services before automatic project capture
counts as working. None have been proven on real accounts yet, so **automatic project capture remains
an unresolved requirement.**

| Check | ChatGPT | Claude | Evidence so far |
|---|---|---|---|
| New and changed messages arrive without copy/paste | Not yet live | Not yet live | Built extension loaded in real Chromium 141 against synthetic pages served at the real hostnames: 2 messages stored, then 4 after a new exchange |
| Long conversations (virtualised threads) | Not yet live | Not yet live | Accumulator tests mount and unmount turns the way both apps do (per July–Sept 2026 measurements in the research notes), including continuous scrolling; "whole conversation" requires a gap-free thread ([D-26](DECISIONS.md)) |
| Edited messages | Not yet live | Not yet live | Reconcile tests: one new version per edit; nothing deleted |
| Phone update later visible on the web | Not yet live | Not yet live | Depends on the services; can only be tested live |
| Catch-up on browser start / wake | Not yet live | Not yet live | Startup and alarm-gap catch-up tested with Chrome API fakes and in real Chromium |

**How capture works (and why).** Both vendors' consumer terms prohibit automated extraction (see
[DECISIONS D-20](DECISIONS.md) and [research notes](research/chat-dom.md)). The helper therefore
defaults to **passive capture**: it records only conversations the owner selected, while the owner
has them open, from the rendered page. It never calls internal APIs, reads cookies or clicks through
challenges. **Background revisits** (every 30 minutes, one visible tab per service) are built but
**off by default** and need an explicit acknowledgement of that risk in the popup.

**What the helper does not collect:** attachment contents, messages the page never rendered, and any
part of a long thread nobody scrolled through. Coverage is reported honestly for each capture.

**Live verification protocol** (owner, about 20 minutes per service):
1. Build and load the helper, pair it, and select one test conversation per service.
2. Send two messages in the conversation → both appear under Projects within a minute.
3. Edit an earlier message → a new version is recorded and the old one remains.
4. Scroll a long conversation from top to bottom → coverage reads "whole conversation" only after the full scroll.
5. Add a message from the phone app → open the conversation on the laptop → it arrives.
6. Quit Chrome, add a message from the phone, reopen Chrome → catch-up runs on startup (passive mode
   captures when the conversation is next opened; revisit mode, if enabled, fetches it).
7. Sign out of the service → the conversation shows "Reconnect" and keeps its data.

Record the results in this file.

---

## Gmail and Google Calendar

| Item | Status |
|---|---|
| OAuth (authorization code + PKCE, offline access, consent) | Verified locally with synthetic token responses |
| Token encryption at rest (AES-256-GCM, bound to the connection) | Verified locally |
| Background refresh + access check every 15 minutes | Verified locally (dispatcher + real Postgres + fake Google endpoints) |
| Refresh still working after 7 days | **Needs live test.** Requires the OAuth app to be **In production**; Testing mode expires refresh tokens after 7 days |
| Mail import, calendar sync, deadlines, receipts | Not started (Milestone 2) |

Verification after setup: `node scripts/verify-google.mjs` prints account type, scopes granted,
consent date and whether the token refreshed. It never prints tokens or message content.

## Outlook mail and calendar

| Item | Status |
|---|---|
| OAuth (confidential Web client, rotating refresh tokens) | Verified locally with synthetic responses |
| Background refresh + `/me` access check every 15 minutes | Verified locally |
| 90-day sliding refresh-token lifetime | **Needs live test.** Only with the redirect URI on the **Web** platform (SPA caps it at 24 hours) |
| Work/school accounts | **Needs live test.** Organisation policy may require admin consent |
| Mail and calendar delta sync | Not started (Milestone 2). Note: Graph v1.0 supports calendar delta on the **default calendar only** |

Verification after setup: `node scripts/verify-microsoft.mjs`.

## Banking: Revolut UK and HSBC UK via Lunch Flow

| Item | Status |
|---|---|
| Read-only client (accounts, balances, transactions; exact minor-unit conversion) | Verified locally with synthetic fixtures |
| Revolut UK personal account | **Unverified** — a coverage page exists; must be confirmed in the trial |
| HSBC UK personal account | **Unverified** — no coverage page was found; must be confirmed in the trial |
| £4.99/month for 4 connections | **Unverified** — the site says plans "start at 4 connections" without a price |
| API base URL | **Conflicting sources** (`lunchflow.app/api/v1` vs `api.lunchflow.com`); configurable via `LUNCHFLOW_BASE_URL` |

Verification after setup: `node scripts/verify-lunchflow.mjs` lists institutions, currencies,
which balance fields exist and transaction date ranges, without names or amounts. Until both banks
are confirmed, banking stays labelled unsupported for the missing one, with CSV import as the
fallback (Milestone 3).

## Gemini

| Item | Status |
|---|---|
| Model IDs `gemini-3.5-flash-lite` and `gemini-3.5-transcribe` | Confirmed in current documentation (secondary sources, 24 Sep 2026) |
| Prices used for budget reservations | **Unverified** — check [the pricing page](https://ai.google.dev/gemini-api/docs/pricing) before relying on £ figures |
| Budget reservations (£15 cap, 80% warning, concurrency-safe) | Verified locally: 40 concurrent £1 requests against £15 → exactly 15 succeed |
| iPhone Safari recordings (`audio/mp4`) | **Unverified** — not on the Developer API's documented MIME list; relabelled as `audio/m4a` and flagged. Live test needed |
| Live request | None made |

## Background jobs

| Item | Status |
|---|---|
| Dispatcher leases, retries, backoff, one briefing per day across DST | Verified locally (8 concurrent workers, 50 jobs, Europe/London DST days) |
| Dispatcher Edge Function (Deno) | Verified locally with Deno 2.9.6 against real Postgres |
| pg_cron → pg_net → Edge Function in a real project | **Needs live test** (setup script tested against stub schemas only) |
| Briefing content | Honest skeleton only; real content arrives in Milestone 2 |

## Owner sign-in

| Item | Status |
|---|---|
| Only the configured Google account becomes owner; every table enforces it | Verified locally (RLS tests, catalogue-wide security invariants, e2e with a second user) |
| Supabase "Before User Created" hook rejects other emails | Verified locally by calling the function; **needs live test** in Supabase Auth |
| Real Google sign-in round trip | **Needs live test** |

## Not started (Milestone 3)

Research notes are in [research/providers.md](research/providers.md). Points that change the plan:

- **Spotify** changed after February 2026: developer-mode apps need a Premium owner and allow 5 users;
  refresh tokens now expire after 6 months (re-consent needed); artist albums return at most 10 per page.
- **WHOOP** app approval has a multi-month backlog, but unapproved apps allow 10 members — enough here.
- **TradingView** moved Market Overview to a new Web Component format in 2026; the legacy embed still works.
- **football-data.org** free tier: scores are delayed; this must be labelled.
