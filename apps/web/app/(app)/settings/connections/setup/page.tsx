import Link from 'next/link'
import { CONNECTION_PROVIDER_INFO, connectionProviders, type Provider } from '@personal-home/core'
import { PageHeader } from '@/components/shell/app-shell'
import { Card } from '@/components/ui/card'
import { ConnectionStatusPill, Pill } from '@/components/ui/status-pill'
import { coreEnv } from '@/lib/env'
import { oauthRedirectUri, providerSetup } from '@/lib/integrations/settings'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Connection setup' }

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="break-all rounded-md border border-line bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-ink">
      {children}
    </code>
  )
}

function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-ink-muted">{children}</ol>
}

function SetupState({ provider }: { provider: Provider }) {
  const s = providerSetup(provider)
  return s.configured ? (
    <Pill tone="positive">Settings present</Pill>
  ) : (
    <ConnectionStatusPill status="needs_setup" />
  )
}

function Section({ provider, children }: { provider: Provider; children: React.ReactNode }) {
  const info = CONNECTION_PROVIDER_INFO[provider]
  return (
    <Card as="section" id={provider} aria-labelledby={`setup-${provider}`} className="scroll-mt-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={`setup-${provider}`} className="text-[15px] font-semibold tracking-tight text-ink">
          {info.displayName}
        </h2>
        {info.requiredSettings.length > 0 ? <SetupState provider={provider} /> : null}
      </div>
      {info.requiredSettings.length > 0 ? (
        <p className="mt-1 text-sm text-ink-muted">
          Server settings:{' '}
          {info.requiredSettings.map((n, i) => (
            <span key={n}>
              {i > 0 ? ', ' : null}
              <Code>{n}</Code>
            </span>
          ))}
        </p>
      ) : null}
      {children}
    </Card>
  )
}

export default async function ConnectionSetupPage() {
  await requireOwner()
  const appUrl = coreEnv().APP_URL
  const later = connectionProviders().filter((p) => p.connectMilestone > 0)

  return (
    <>
      <PageHeader
        title="Connection setup"
        subtitle="Where each server setting comes from. Only setting names appear here; values stay in your server configuration."
        actions={
          <Link
            href="/settings/connections"
            className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm text-accent hover:bg-surface-muted sm:min-h-10"
          >
            Back to Connections
          </Link>
        }
      />

      <div className="space-y-4">
        <Card as="section" aria-labelledby="setup-where">
          <h2 id="setup-where" className="text-[15px] font-semibold tracking-tight text-ink">
            Where settings go
          </h2>
          <Steps>
            <li>
              Web app: Vercel → Project → Settings → Environment Variables (Production), or{' '}
              <Code>apps/web/.env.local</Code> for local development.
            </li>
            <li>
              Background jobs: Supabase dashboard → Edge Functions → Secrets. The jobs need the same{' '}
              <Code>TOKEN_ENCRYPTION_KEY</Code> and provider client settings as the web app.
            </li>
            <li>
              <Code>TOKEN_ENCRYPTION_KEY</Code> encrypts stored refresh tokens (32 random bytes,
              base64: <Code>openssl rand -base64 32</Code>). Changing it makes stored tokens
              unreadable, so every account would need reconnecting.
            </li>
            <li>
              <Code>APP_URL</Code> is this app&apos;s public origin (currently <Code>{appUrl}</Code>
              ). OAuth redirect addresses below are built from it and must match the provider
              consoles exactly.
            </li>
          </Steps>
        </Card>

        <Section provider="google">
          <Steps>
            <li>
              Google Cloud Console → select or create a project → APIs &amp; Services → Library:
              enable the <strong>Gmail API</strong> and the <strong>Google Calendar API</strong>.
            </li>
            <li>
              Google Auth Platform (the former “OAuth consent screen”) → Audience: user type{' '}
              <strong>External</strong>, publishing status <strong>In production</strong>. Do not
              leave it in Testing: with Gmail or Calendar scopes, Testing refresh tokens expire
              after 7 days. Personal use (fewer than 100 users you know) needs no verification;
              Google will show “Google hasn’t verified this app” — choose Advanced, then Go to the
              app.
            </li>
            <li>
              Data Access (scopes): <Code>openid</Code>, <Code>email</Code>,{' '}
              <Code>https://www.googleapis.com/auth/gmail.readonly</Code>,{' '}
              <Code>https://www.googleapis.com/auth/calendar.calendarlist.readonly</Code>,{' '}
              <Code>https://www.googleapis.com/auth/calendar.events.readonly</Code>. All read-only.
            </li>
            <li>
              Clients → Create client → application type <strong>Web application</strong>.
              Authorised redirect URI: <Code>{oauthRedirectUri('google', appUrl)}</Code>. Use a
              separate client from the one Supabase uses for dashboard sign-in: mailbox consent is
              kept apart from signing in.
            </li>
            <li>
              Copy the client ID into <Code>GOOGLE_OAUTH_CLIENT_ID</Code> and the client secret into{' '}
              <Code>GOOGLE_OAUTH_CLIENT_SECRET</Code>.
            </li>
            <li>
              After connecting, the owner can check background access with{' '}
              <Code>node --env-file=apps/web/.env.local scripts/verify-google.mjs</Code>.
            </li>
          </Steps>
        </Section>

        <Section provider="microsoft">
          <Steps>
            <li>
              Microsoft Entra admin center (or Azure portal) → App registrations → New registration.
            </li>
            <li>
              Supported account types:{' '}
              <strong>
                accounts in any organisational directory and personal Microsoft accounts
              </strong>{' '}
              (multitenant + personal). The app signs in through the <Code>common</Code> endpoint.
            </li>
            <li>
              Redirect URI: platform <strong>Web</strong> (not “Single-page application”: SPA
              refresh tokens expire after 24 hours), address{' '}
              <Code>{oauthRedirectUri('microsoft', appUrl)}</Code>.
            </li>
            <li>
              Certificates &amp; secrets → New client secret with an expiry of at most 24 months
              (Microsoft recommends under 12). Copy its <strong>Value</strong> immediately into{' '}
              <Code>MICROSOFT_CLIENT_SECRET</Code> and note the expiry date: connections stop
              working when it expires.
            </li>
            <li>
              Overview → Application (client) ID into <Code>MICROSOFT_CLIENT_ID</Code>.
            </li>
            <li>
              API permissions → Microsoft Graph → Delegated: <Code>offline_access</Code>,{' '}
              <Code>openid</Code>, <Code>profile</Code>, <Code>email</Code>, <Code>User.Read</Code>,{' '}
              <Code>Mail.Read</Code>, <Code>Calendars.Read</Code>. A work or school tenant may
              require an administrator to approve them.
            </li>
            <li>
              Microsoft has no API for apps to revoke access. After disconnecting, remove the app
              from your Microsoft account’s app permissions (personal accounts) or My Apps
              (work/school accounts).
            </li>
            <li>
              Check background access with{' '}
              <Code>node --env-file=apps/web/.env.local scripts/verify-microsoft.mjs</Code>.
            </li>
          </Steps>
        </Section>

        <Section provider="lunchflow">
          <Steps>
            <li>
              Lunch Flow dashboard → Destinations → add an <strong>API</strong> destination and copy
              its key into <Code>LUNCHFLOW_API_KEY</Code> (server only; never in the browser).
            </li>
            <li>
              Check that both Revolut UK and HSBC UK personal accounts are covered during the trial,
              and confirm the price at checkout before paying.
            </li>
            <li>
              Validate the account types with{' '}
              <Code>node --env-file=apps/web/.env.local scripts/verify-lunchflow.mjs</Code>. Banking
              import arrives in Milestone 3; balances refresh about once a day and are never shown
              as live.
            </li>
          </Steps>
        </Section>

        <Card as="section" id="chatgpt" aria-labelledby="setup-chat" className="scroll-mt-6">
          <h2 id="setup-chat" className="text-[15px] font-semibold tracking-tight text-ink">
            ChatGPT and Claude
          </h2>
          <p id="claude" className="mt-1 text-sm text-ink-muted">
            No server settings. Conversations are collected by the Chrome helper:{' '}
            <Link
              href="/settings/chrome-helper"
              className="text-accent underline-offset-2 hover:underline"
            >
              set up the Chrome helper
            </Link>
            .
          </p>
        </Card>

        <Card as="section" aria-labelledby="setup-later">
          <h2 id="setup-later" className="text-[15px] font-semibold tracking-tight text-ink">
            Later milestones
          </h2>
          <ul className="mt-2 space-y-2 text-sm text-ink-muted">
            {later.map((p) => (
              <li key={p.provider} id={p.provider} className="scroll-mt-6">
                <span className="font-medium text-ink">{p.displayName}</span> — Milestone{' '}
                {p.connectMilestone}.{' '}
                {p.requiredSettings.length > 0 ? (
                  <>
                    Settings:{' '}
                    {p.requiredSettings.map((n, i) => (
                      <span key={n}>
                        {i > 0 ? ', ' : null}
                        <Code>{n}</Code>
                      </span>
                    ))}
                  </>
                ) : (
                  'No server settings.'
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  )
}
