# Implementation checklist

_Updated 24 September 2026._ Tracks the brief's build sequence (§9) and acceptance areas (§10).

**Key:** ✅ done and tested · 🔑 built, waiting on owner setup or a live check · ⏳ next milestone · ◻ not started

---

## Milestone 0: foundation and hard dependencies ✅

| Item                                                   | Status | Notes                                                                                              |
| ------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| pnpm workspace, shared types, current package versions | ✅     | Next 16.3, React 19.3, TypeScript 6.0, Tailwind 4.3 ([D-04](DECISIONS.md))                         |
| Local database for development and tests               | ✅     | Postgres 16 plus a Supabase shim; no Docker needed ([D-10](DECISIONS.md))                          |
| Owner-only authentication                              | ✅ 🔑  | RLS on every table, security invariant tests, sign-up hook. The live Google round trip is untested |
| Job framework                                          | ✅ 🔑  | Leases, retries, one briefing per day across DST, Deno dispatcher. Live pg_cron is untested        |
| Minimal Home and Connections                           | ✅     | Superseded by Milestone 1 Home                                                                     |
| Chrome capture prototype, both services                | ✅ 🔑  | Passive by default; revisits opt-in ([D-20](DECISIONS.md)). **Live early gate not yet run**        |
| Gmail and Outlook OAuth; background token refresh      | ✅ 🔑  | Access check every 15 minutes. Live accounts untested                                              |
| Lunch Flow bank validation                             | 🔑     | Client built. Revolut UK and HSBC UK coverage unverified                                           |
| AI gateway and spending reservations                   | ✅ 🔑  | £15 cap, concurrency-safe, source restrictions. No live Gemini call yet                            |
| Integration results document                           | ✅     | [INTEGRATION_RESULTS.md](INTEGRATION_RESULTS.md)                                                   |

## Milestone 1: a useful personal home ✅

| Item                                                     | Status | Notes                                                                      |
| -------------------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| Responsive navigation (sidebar and bottom bar, More)     | ✅     | e2e at 390px and 1280px                                                    |
| Local tasks, reminders, habits                           | ✅     | Safe across DST; honest missed days; reminders are in-app for now          |
| Day and week views                                       | ✅     | Calendar events arrive with Milestone 2                                    |
| Daily planner with conflict checks and edit preservation | ✅     | Property-tested; database blocks overlaps ([D-31](DECISIONS.md))           |
| Notes (search, offline drafts, conflict-safe)            | ✅     |                                                                            |
| Voice and text journal                                   | ✅ 🔑  | Transcription needs `GEMINI_API_KEY`. iPhone `audio/mp4` not verified live |
| Reading, learning goals, people                          | ✅     |                                                                            |
| Quick capture (task, note, journal, reading log)         | ✅     |                                                                            |
| Useful empty and disconnected states                     | ✅     | Every module states what feeds it                                          |
| Installable PWA with offline shell                       | ✅ 🔑  | Real iPhone install untested (no WebKit here)                              |

## Milestone 2: connected email, projects and daily guidance ⏳

- ◻ Multi-account Gmail and Outlook mail and calendar sync (history IDs, sync tokens, delta links)
- ◻ Deadlines, action requests and subscription candidates from email, with evidence
- ◻ Project summaries from captured conversations (`capture.summarize`)
- ◻ Real 11:00 briefing and 22:00 review content; planner refresh at 11:00
- ◻ Dashboard chat (read-only retrieval with evidence links)
- ◻ Web Push, in-app notification inbox, generic lock-screen text
- ◻ Budget and usage screen in Settings

## Milestone 3: health, money and interests ⏳

- ◻ WHOOP (v2, hourly, pending shown as pending)
- ◻ Banking via Lunch Flow once verified; CSV import fallback
- ◻ Spotify listening-based artists and releases (never sent to AI)
- ◻ Liverpool, Premier League and Champions League (football-data.org, delay labelled)
- ◻ Financial news, AI updates (RSS), Markets (sandboxed TradingView widget)

## Milestone 4: private release ⏳

- ◻ Export (JSON plus Markdown) and deletion; backup restore test
- ◻ Real iPhone install and notifications
- ◻ Private deployment and a remaining-limitations list

---

## Acceptance areas (§10)

| Area                                               | Where it stands                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Access                                             | ✅ Tested locally: RLS, anon, non-owner, forged cookie, second mailbox cannot become owner |
| Mobile                                             | ✅ 390px e2e, 44px targets, keyboard paths. 🔑 Real Safari and PWA install                 |
| Daily plan                                         | ✅ All rules tested, including DST and property tests                                      |
| Capture                                            | 🔑 Built and tested with synthetic pages; the live five-point gate is outstanding          |
| Email and calendar                                 | ⏳ Access checks only; sync is Milestone 2                                                 |
| Briefings                                          | ✅ Scheduling, DST and dedupe tested. ⏳ Content                                           |
| Subscriptions, banking, health, Spotify, interests | ⏳ Milestone 3                                                                             |
| Journal                                            | ✅ Recording, denial, failed upload and retry keep drafts; no mood feature                 |
| Budget                                             | ✅ Concurrency, cap exhaustion, ambiguous failures                                         |
| Privacy                                            | ✅ Prompt-injection containment, token handling, retention purge. ⏳ Export and delete     |
| Reliability                                        | ✅ Per-account and per-section isolation, no fabricated data                               |
