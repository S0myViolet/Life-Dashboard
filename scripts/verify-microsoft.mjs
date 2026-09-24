#!/usr/bin/env node
/**
 * Owner-run verification of Microsoft (Outlook) background access (Milestone 0).
 *
 *   node --env-file=apps/web/.env.local scripts/verify-microsoft.mjs [--connection <id>] [--no-refresh] [--show-labels]
 *
 * Same as scripts/verify-google.mjs, for Microsoft accounts: refreshes each
 * stored refresh token (Microsoft rotates it on every use; the new one is
 * stored atomically), calls Graph GET /me, records the outcome and prints a
 * Markdown report for docs/INTEGRATION_RESULTS.md. Prints no tokens, secrets or
 * message content.
 *
 * Needs: DATABASE_URL, TOKEN_ENCRYPTION_KEY, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET.
 * Cannot run inside the build container (no route to Microsoft or Supabase).
 */
import { pathToFileURL } from 'node:url'
import { runOAuthVerification } from './verify-google.mjs'

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runOAuthVerification('microsoft').then(
    (code) => process.exit(code),
    (err) => {
      console.error(`Verification could not run: ${err instanceof Error ? err.message : 'unknown error'}`)
      process.exit(1)
    },
  )
}
