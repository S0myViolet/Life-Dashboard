# Setup

How to take Personal Home from this repository to a private deployment you can open on your phone
and laptop. Work through the steps in order; each connection after step 3 is optional and can be
added whenever you like. The dashboard stays useful with none of them.

Keep every secret in the Vercel and Supabase dashboards (or a local `.env.local`), never in chat,
commits or screenshots. Setting names are listed in [`.env.example`](../.env.example).

**You will need:** a Supabase account (Pro plan), a Vercel account (Hobby), a Google account, and
about an hour for steps 1–3.

---

## 1 · Supabase project

1. Create a project on the **Pro** plan with **Micro** compute. Pick the region closest to you
   (for the UK, London). Save the **database password** you choose in your password manager. Leave
   the **Spend Cap on** (the default). The cap blocks usage overages but does not cover compute
   add-ons, so add none.
2. Find your **project ref**. It is the short code in the dashboard address
   (`supabase.com/dashboard/project/<ref>`), and also appears under **Project Settings → General → Project ID**.
3. Get the code onto your laptop. You need [Node.js 22 LTS](https://nodejs.org) and nothing else
   for this step.
   - On GitHub, switch the branch picker to `claude/stoic-thompson-zc3g4g`, then choose
     **Code → Download ZIP**, and unzip it.
   - Or clone it: `git clone -b claude/stoic-thompson-zc3g4g https://github.com/S0myViolet/Life-Dashboard.git`.
4. Open **Terminal** (Mac) or **PowerShell** (Windows) in that folder and run these three commands:
   ```sh
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
   - `login` opens your browser to approve access. If npx asks to install `supabase`, answer **y**.
   - `link` asks for the database password from step 1. Type it into the terminal, never into a chat.
   - `db push` lists 12 migrations and asks to confirm. Answer **Y**. This exact command was tested
     against a fresh database with the real Supabase CLI (2.117.0): all 12 applied, and every table
     is owner-only.
5. Check it worked: **Table Editor** should list tables such as `tasks`, `habits`, `notes` and `people`.
6. **Database → Extensions:** enable `pg_cron` and `pg_net`.
7. **Project Settings → API Keys:** note the project URL, the **publishable** key and a **secret** key.

## 2 · Owner sign-in (Google)

1. In [Google Cloud Console](https://console.cloud.google.com), create a project, then
   **Google Auth Platform → Clients → Create client → Web application**. Add this authorised
   redirect URI: `https://<your-project-ref>.supabase.co/auth/v1/callback`.
2. In Supabase, go to **Authentication → Sign In / Providers → Google**. Paste the client ID and secret, then enable it.
3. **Authentication → URL Configuration:** set **Site URL** to your app address (for example
   `https://home.example.com`) and add `https://home.example.com/auth/callback` to the redirect URLs.
4. **Restrict sign-ups to you** (defence in depth; the app also checks `OWNER_EMAIL`):
   - In the **SQL Editor**, run
     `insert into private.owner_allowlist (email) values (lower('you@gmail.com'));`
   - **Authentication → Hooks → Before User Created:** choose the Postgres function
     `public.hook_before_user_created`.
5. Deploy the web app to Vercel (root directory `apps/web`) with these environment variables:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` (nothing after `.co`) |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key |
   | `SUPABASE_SECRET_KEY` | Secret key |
   | `DATABASE_URL` | Connect → **Transaction pooler** URI (port 6543) |
   | `OWNER_EMAIL` | Your Google address |
   | `APP_URL` | Your app address, no trailing slash |
   | `TOKEN_ENCRYPTION_KEY` | Output of `openssl rand -base64 32` |

6. Open the app and sign in with Google. The first verified sign-in with `OWNER_EMAIL` becomes the
   owner; any other account is signed out and removed.

## 3 · Background jobs (briefings with the laptop closed)

1. Set the function secrets (same `TOKEN_ENCRYPTION_KEY` as Vercel):
   ```sh
   npx supabase secrets set DISPATCHER_SECRET="$(openssl rand -base64 32)" TOKEN_ENCRYPTION_KEY=<same as Vercel>
   npx supabase functions deploy dispatcher
   ```
2. Open [`supabase/setup/10_schedule_dispatcher.sql`](../supabase/setup/10_schedule_dispatcher.sql),
   paste it into the **SQL Editor**, and fill in your project URL and the same `DISPATCHER_SECRET`
   **in the editor only**. Do not save the filled-in copy anywhere. Run it once.
3. Check it: after a few minutes, `select * from cron.job_run_details order by start_time desc limit 5;`
   should show successful runs. The 11:00 and 22:00 briefings then appear on Home. They wait until
   you have **confirmed your timezone** in Settings.

## 4 · Gmail and Google Calendar (optional)

1. In the same Google Cloud project, enable the **Gmail API** and **Google Calendar API**.
2. **Google Auth Platform → Audience:** user type **External**, publishing status **In production**.
   Do not leave it in Testing, because Testing expires refresh tokens after 7 days. Google will show an
   "unverified app" screen when you connect; personal use is exempt from verification, so continue
   through **Advanced**.
3. **Data Access:** add `gmail.readonly`, `calendar.calendarlist.readonly` and `calendar.events.readonly`.
4. Add a second authorised redirect URI to your Web client: `https://home.example.com/api/connections/google/callback`.
5. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in Vercel **and** as Supabase function secrets.
6. In the app, go to **Settings → Connections → Connect a Google account**. Repeat for each Gmail account.
7. Verify: `node scripts/verify-google.mjs` (reads `apps/web/.env.local`). Then record the result in
   [INTEGRATION_RESULTS.md](INTEGRATION_RESULTS.md), and check again after 7 days.

## 5 · Outlook mail and calendar (optional)

1. In the [Azure portal](https://portal.azure.com), go to **App registrations → New registration**. Choose supported
   account types **"Accounts in any organisational directory and personal Microsoft accounts"**.
2. **Authentication → Add a platform → Web** (not Single-page application). Redirect URI:
   `https://home.example.com/api/connections/microsoft/callback`.
3. **Certificates & secrets → New client secret.** Choose an expiry of 12 months or less, then copy the **Value**.
4. **API permissions → Microsoft Graph → Delegated:** `offline_access`, `openid`, `profile`,
   `email`, `User.Read`, `Mail.Read`, `Calendars.Read`.
5. Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` in Vercel and as function secrets.
6. Connect from **Settings → Connections**. Work or school accounts may need an administrator to approve.
7. Verify with `node scripts/verify-microsoft.mjs`.

## 6 · AI (optional)

1. Create a Gemini API key in Google AI Studio and **link a Cloud Billing account**. Paid-tier content
   is not used to improve Google's products.
2. Set `GEMINI_API_KEY` in Vercel and as a function secret. The monthly cap defaults to £15 with a
   warning at 80%. Without a key, everything except AI summaries and transcription keeps working.

## 7 · Chrome helper for ChatGPT and Claude (optional)

1. Build it: `pnpm --filter @personal-home/extension build`.
2. In Chrome, go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose `apps/extension/dist`.
3. In the dashboard, go to **Settings → Chrome helper → Create pairing code**. Enter the code and your app
   address in the helper's **Options** page, then allow the permission prompt.
4. On a ChatGPT or Claude conversation, click the helper's **Track this conversation**, then confirm
   the project in the dashboard.
5. Read the terms-of-use note before enabling **background revisits**. They are off by default
   ([why](DECISIONS.md#d-20--chrome-helper-passive-capture-by-default-background-revisits-opt-in)).
6. Run the live checks in [INTEGRATION_RESULTS.md](INTEGRATION_RESULTS.md#chatgpt-and-claude-capture--the-briefs-early-gate).

## 8 · Banking via Lunch Flow (optional, verify before paying)

1. Start the Lunch Flow trial and connect Revolut UK and HSBC UK.
2. Under **Destinations**, add an API destination and copy its key into `LUNCHFLOW_API_KEY`.
3. Run `node scripts/verify-lunchflow.mjs` and confirm **both** banks appear with the account types
   you use before subscribing. Coverage of HSBC UK personal accounts has not been confirmed.

## 9 · iPhone

1. Open the app in **Safari**, tap **Share → Add to Home Screen**, and launch it from the icon.
2. Notifications arrive in Milestone 2. When they do, you will turn them on from **Settings → Notifications**; nothing asks
   for permission before then.

---

## Local development

```sh
pnpm install
node scripts/local-db.mjs start        # throwaway Postgres 16 on 127.0.0.1:54329 (no Docker)
pnpm test                              # all unit and database tests
pnpm --filter @personal-home/web test:e2e   # Playwright against a production build
pnpm functions:check                   # Deno checks and tests for the dispatcher
```

Signing in locally needs a Supabase project (steps 1–2 with `APP_URL=http://localhost:3000`) or the
Supabase CLI. The Playwright suite uses a test-only sign-in that only works outside Vercel.
