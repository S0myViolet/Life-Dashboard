# Personal Home

A calm, private home for one person. Open it on your phone or laptop to see what matters, what
changed and what to do today. It brings together tasks, habits, a daily plan, notes, a voice
journal, reading and people, and later your mail, calendar, projects, health, money and interests.

**Status:** Milestones 0 and 1 are complete. See the [implementation checklist](docs/IMPLEMENTATION_CHECKLIST.md)
and [integration results](docs/INTEGRATION_RESULTS.md) for what is verified and what needs your setup.

## Documents

|                                                    |                                                               |
| -------------------------------------------------- | ------------------------------------------------------------- |
| [Product brief](docs/PRODUCT_BRIEF.md)             | The source of truth for what is being built                   |
| [Setup](docs/SETUP.md)                             | From a new Supabase project to a private deployment           |
| [Decisions](docs/DECISIONS.md)                     | How the brief was interpreted, and why                        |
| [Integration results](docs/INTEGRATION_RESULTS.md) | What each connection can actually do today                    |
| [Chrome helper](apps/extension/README.md)          | ChatGPT and Claude capture: what it does and does not collect |

## Try it locally

```sh
pnpm install
node scripts/local-db.mjs start          # throwaway Postgres 16, no Docker
pnpm test                                # unit and database tests
pnpm --filter @personal-home/web test:e2e   # browser tests against a production build
```

`node scripts/seed-demo.mjs` fills a **local** database with clearly labelled demo data (remove it
with `--remove`). It refuses to run against anything that isn't localhost.

## Layout

`apps/web` (Next.js PWA) · `apps/extension` (Chrome helper) · `packages/core` (domain logic) ·
`packages/db` (Postgres access, RLS) · `packages/integrations` (provider clients) ·
`packages/jobs` (background jobs) · `supabase/` (migrations, dispatcher function, one-time setup SQL).
Engineering conventions are in [CLAUDE.md](CLAUDE.md).
