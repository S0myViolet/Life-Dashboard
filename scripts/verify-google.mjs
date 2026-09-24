#!/usr/bin/env node
/**
 * Owner-run verification of Google background access (Milestone 0).
 *
 *   node --env-file=apps/web/.env.local scripts/verify-google.mjs [--connection <id>] [--no-refresh] [--show-labels]
 *
 * For every connected Google account (or one): loads and decrypts the stored
 * tokens, refreshes the access token (proving the refresh token still works,
 * e.g. more than 7 days after consent), calls the Gmail profile endpoint (or
 * the calendar list / userinfo when Gmail was not granted), records the outcome
 * on the connection exactly as the background job does, and prints a Markdown
 * report for docs/INTEGRATION_RESULTS.md.
 *
 * Prints no tokens, no secrets and no message content. Account addresses are
 * masked unless --show-labels is given.
 *
 * Needs: DATABASE_URL (a role that can read the `private` schema, e.g. the
 * Supabase `postgres` role via the session pooler or direct connection),
 * TOKEN_ENCRYPTION_KEY, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET.
 * Runs the workspace TypeScript directly: Node 22.18+ (or add --experimental-strip-types).
 * It cannot run inside the build container (no route to Google or Supabase).
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PROVIDER_SETTINGS = {
  google: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
  microsoft: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
}
const PROVIDER_NAMES = {
  google: 'Google (Gmail + Calendar)',
  microsoft: 'Microsoft (Outlook mail + calendar)',
}

/** Load apps/web/.env.local and .env when present, without overriding variables already set. */
export function loadOwnerEnv() {
  for (const file of [resolve(ROOT, 'apps/web/.env.local'), resolve(ROOT, '.env')]) {
    if (!existsSync(file)) continue
    try {
      process.loadEnvFile(file)
    } catch {
      // Unreadable file: rely on the environment.
    }
  }
}

/** `owner.name@gmail.com` → `o••••@gmail.com`. */
export function maskLabel(label) {
  const at = label.lastIndexOf('@')
  if (at <= 0) return `${label.slice(0, 1)}••••`
  return `${label.slice(0, 1)}••••${label.slice(at)}`
}

const iso = (d) => (d ? new Date(d).toISOString() : 'n/a')

/** Account kind from the id token when the refresh returned one; otherwise a labelled guess from the address. */
function accountType(provider, kind, label) {
  if (kind !== 'unknown') return kind
  if (provider === 'google' && /@(gmail|googlemail)\.com$/i.test(label))
    return 'personal (inferred from a gmail.com address)'
  return 'unknown (the refresh returned no id token)'
}

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000)
}

async function importWorkspace() {
  if (!process.features?.typescript) {
    throw new Error(
      'This Node.js cannot run TypeScript directly. Use Node 22.18+ or add --experimental-strip-types.',
    )
  }
  const url = (p) => pathToFileURL(resolve(ROOT, p)).href
  const [core, db, integrations, jobs] = await Promise.all([
    import(url('packages/core/src/index.ts')),
    import(url('packages/db/src/index.ts')),
    import(url('packages/integrations/src/index.ts')),
    import(url('packages/jobs/src/index.ts')),
  ])
  return { core, db, integrations, jobs }
}

/**
 * Verify every (or one) connection of `provider` and print a report.
 * Returns the process exit code: 0 when every checked account succeeded.
 */
export async function runOAuthVerification(provider, argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      connection: { type: 'string' },
      'no-refresh': { type: 'boolean', default: false },
      'show-labels': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  })
  if (values.help) {
    console.log(
      `Usage: node --env-file=apps/web/.env.local scripts/verify-${provider}.mjs [--connection <id>] [--no-refresh] [--show-labels]`,
    )
    return 0
  }

  loadOwnerEnv()
  const required = ['DATABASE_URL', 'TOKEN_ENCRYPTION_KEY', ...PROVIDER_SETTINGS[provider]]
  const missing = required.filter((n) => !(process.env[n] ?? '').trim())
  if (missing.length > 0) {
    console.error(`Missing settings (names only): ${missing.join(', ')}`)
    return 2
  }

  const { core, db, integrations, jobs } = await importWorkspace()
  const key = await core.connectionEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY)
  if (!key) {
    console.error('TOKEN_ENCRYPTION_KEY is not 32 bytes of base64.')
    return 2
  }
  const lookup = integrations.oauthAdapterFromSettings(provider, (n) => process.env[n])
  if (!lookup.ok) {
    console.error(`Missing settings (names only): ${lookup.missing.join(', ')}`)
    return 2
  }

  const sql = db.createDb(process.env.DATABASE_URL, {
    max: 2,
    applicationName: `verify-${provider}`,
  })
  const label = (l) => (values['show-labels'] ? l : maskLabel(l))
  let failures = 0
  try {
    const all = await db.withService(sql, (tx) => db.connectionsList(tx, provider))
    const targets = values.connection ? all.filter((c) => c.id === values.connection) : all
    const startedAt = new Date()
    const lines = [
      `### ${PROVIDER_NAMES[provider]} — background access check`,
      '',
      `- Run at: ${startedAt.toISOString()} (owner-run \`scripts/verify-${provider}.mjs\` against the live provider)`,
      `- Accounts checked: ${targets.length}${values.connection ? ' (single connection)' : ''}`,
      `- Forced refresh: ${values['no-refresh'] ? 'no' : 'yes'}`,
      '',
    ]
    if (targets.length === 0) {
      lines.push(
        values.connection
          ? '_No connection with that id._'
          : `_No ${provider} accounts are connected. Connect one in Settings → Connections first._`,
      )
      failures++
    }

    for (const conn of targets) {
      const events = await db.withService(
        sql,
        (tx) => tx`
          select kind, created_at from public.connection_events
          where connection_id = ${conn.id} and kind in ('connected', 'reconnected')
          order by created_at desc limit 1`,
      )
      const consentAt = events[0]?.createdAt ?? conn.createdAt
      const report = await jobs.connectionVerifyAccess(
        { db: sql, fetch: globalThis.fetch, now: () => new Date(), adapter: lookup.adapter, key },
        conn.id,
        { ignoreSchedule: true, includeNeedsReconnect: true, forceRefresh: !values['no-refresh'] },
      )
      const after = report.connection ?? conn
      const coverage = core.connectionScopeCoverage(provider, after.grantedScopes)
      const ok = report.outcome === 'succeeded'
      if (!ok) failures++
      lines.push(
        `#### ${label(conn.accountLabel)} (connection ${conn.id.slice(0, 8)}) — ${ok ? 'PASS' : report.outcome === 'skipped_paused' ? 'SKIPPED (paused)' : 'FAIL'}`,
        '',
        `- Account type: ${accountType(provider, report.accountKind, after.accountLabel)}`,
        `- Consent given: ${iso(consentAt)} (${daysBetween(new Date(consentAt), startedAt)} days ago)`,
        `- Scopes granted: ${after.grantedScopes.map((s) => core.connectionDescribeScope(s)).join(', ') || 'none recorded'}`,
        `- Mail access: ${coverage.mail ? 'yes' : 'no'}; calendar access: ${coverage.calendar ? 'yes' : 'no'}${coverage.missing.length ? `; not granted: ${coverage.missing.map((s) => core.connectionDescribeScope(s)).join(', ')}` : ''}`,
        `- Access token refreshed: ${report.refreshed ? 'yes' : 'no'}; refresh token rotated: ${report.refreshTokenRotated ? 'yes (new one stored)' : 'no'}`,
        `- New access token expires: ${iso(report.accessTokenExpiresAt)}`,
        `- Identity endpoint: ${report.endpoint ?? 'not reached'}${
          Object.keys(report.facts).length
            ? ` (${Object.entries(report.facts)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ')})`
            : ''
        }`,
        `- Status after check: ${report.statusAfter ?? 'unknown'}; last success: ${iso(after.lastSuccessAt)}; last attempt: ${iso(after.lastAttemptAt)}`,
      )
      if (report.failure)
        lines.push(`- Failure: \`${report.failure.code}\` — ${report.failure.message}`)
      lines.push('')
    }
    console.log(lines.join('\n'))
  } finally {
    await sql.end({ timeout: 5 })
  }
  return failures === 0 ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runOAuthVerification('google').then(
    (code) => process.exit(code),
    (err) => {
      // Messages from our own code are already sanitised; never print stacks with request data.
      console.error(
        `Verification could not run: ${err instanceof Error ? err.message : 'unknown error'}`,
      )
      process.exit(1)
    },
  )
}
