#!/usr/bin/env node
/**
 * Owner-run verification of the Lunch Flow Personal API (Milestone 0).
 *
 *   node --env-file=apps/web/.env.local scripts/verify-lunchflow.mjs [--no-transactions] [--show-names]
 *
 * Calls GET /accounts with LUNCHFLOW_API_KEY, then each account's balance and
 * transactions (read-only), and prints a Markdown report for
 * docs/INTEGRATION_RESULTS.md: which institutions and account types are
 * visible (to validate Revolut UK and HSBC UK personal accounts), their status,
 * currency, whether balances and transaction amounts are present and exact,
 * transaction counts and date coverage.
 *
 * Prints no API key, no balances, no amounts, no merchant names and no
 * transaction descriptions. Account names (which can contain the owner's name)
 * are hidden unless --show-names is given; institution names are shown.
 *
 * Needs: LUNCHFLOW_API_KEY. Optional: LUNCHFLOW_BASE_URL (default
 * https://lunchflow.app/api/v1; Lunch Flow's own actual-flow client uses
 * https://api.lunchflow.com — try it if the default answers 404).
 * Runs the workspace TypeScript directly: Node 22.18+ (or add --experimental-strip-types).
 * Cannot run inside the build container (no route to Lunch Flow).
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { loadOwnerEnv } from './verify-google.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function runLunchflowVerification(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'no-transactions': { type: 'boolean', default: false },
      'show-names': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  })
  if (values.help) {
    console.log(
      'Usage: node --env-file=apps/web/.env.local scripts/verify-lunchflow.mjs [--no-transactions] [--show-names]',
    )
    return 0
  }

  loadOwnerEnv()
  const apiKey = (process.env.LUNCHFLOW_API_KEY ?? '').trim()
  if (!apiKey) {
    console.error('Missing settings (names only): LUNCHFLOW_API_KEY')
    return 2
  }
  if (!process.features?.typescript) {
    console.error('This Node.js cannot run TypeScript directly. Use Node 22.18+ or add --experimental-strip-types.')
    return 2
  }
  const integrations = await import(pathToFileURL(resolve(ROOT, 'packages/integrations/src/index.ts')).href)
  const core = await import(pathToFileURL(resolve(ROOT, 'packages/core/src/index.ts')).href)

  const client = integrations.createLunchflowClient({
    apiKey,
    baseUrl: process.env.LUNCHFLOW_BASE_URL,
    fetch: globalThis.fetch,
  })
  const startedAt = new Date()
  const lines = [
    '### Lunch Flow Personal API — account coverage check',
    '',
    `- Run at: ${startedAt.toISOString()} (owner-run \`scripts/verify-lunchflow.mjs\` against the live provider)`,
    `- Base URL: ${client.baseUrl}`,
  ]

  let accounts
  try {
    accounts = await client.listAccounts()
  } catch (err) {
    const f = core.toConnectionFailure(err)
    lines.push(`- Accounts: FAIL — \`${f.code}\` ${f.message}`)
    console.log(lines.join('\n'))
    return 1
  }
  lines.push(`- Accounts visible: ${accounts.length}`, '')
  if (accounts.length === 0) {
    lines.push('_The API key works but no accounts are linked to this Lunch Flow destination._')
    console.log(lines.join('\n'))
    return 1
  }

  let failures = 0
  lines.push(
    '| Institution | Account | Status | Currency | Aggregator | Balance fields | Transactions | Booked dates | Pending | Exact amounts |',
    '|---|---|---|---|---|---|---|---|---|---|',
  )
  for (const a of accounts) {
    let balanceCell = 'n/a'
    try {
      const b = await client.getBalance(a.id)
      const field = (m, name) =>
        m === null ? `${name}: missing` : `${name}: present${m.amountMinor === null ? ' (not exact)' : ''}`
      balanceCell = `${field(b.available, 'available')}; ${field(b.current, 'current')}`
    } catch (err) {
      failures++
      balanceCell = `FAIL \`${core.toConnectionFailure(err).code}\``
    }

    let txCells = ['skipped', 'skipped', 'skipped', 'skipped']
    if (!values['no-transactions']) {
      try {
        const txns = await client.listTransactions(a.id, { includePending: true, accountCurrency: a.currency })
        const dates = txns.map((t) => t.bookedDate).filter(Boolean).sort()
        const undated = txns.length - dates.length
        const exact = txns.filter((t) => t.money.amountMinor !== null).length
        txCells = [
          String(txns.length),
          dates.length ? `${dates[0]} → ${dates[dates.length - 1]}${undated ? ` (+${undated} unparsed)` : ''}` : undated ? `${undated} unparsed` : 'none',
          String(txns.filter((t) => t.pending).length),
          `${exact}/${txns.length}`,
        ]
      } catch (err) {
        failures++
        txCells = [`FAIL \`${core.toConnectionFailure(err).code}\``, '', '', '']
      }
    }
    const cell = (v) => String(v ?? 'unknown').replace(/\|/g, '/')
    lines.push(
      `| ${cell(a.institutionName)} | ${values['show-names'] ? cell(a.name) : `hidden (id ${a.id})`} | ${a.status} | ${a.currency ?? 'unknown'} | ${cell(a.aggregator)} | ${balanceCell} | ${txCells.join(' | ')} |`,
    )
  }
  lines.push(
    '',
    '_Balances and amounts are deliberately not printed. Lunch Flow refreshes UK data about once a day; confirm both the Revolut UK and HSBC UK personal accounts appear above before treating banking as connected._',
  )
  console.log(lines.join('\n'))
  return failures === 0 ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runLunchflowVerification().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`Verification could not run: ${err instanceof Error ? err.message : 'unknown error'}`)
      process.exit(1)
    },
  )
}
