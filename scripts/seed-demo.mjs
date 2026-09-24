#!/usr/bin/env node
/**
 * Seed clearly labelled demo data into a LOCAL database, or remove it again.
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/<db> node scripts/seed-demo.mjs
 *   DATABASE_URL=... node scripts/seed-demo.mjs --remove
 *   node scripts/seed-demo.mjs --database-url postgres://postgres@127.0.0.1:54329/<db>
 *
 * Refuses to run when NODE_ENV=production, when VERCEL/VERCEL_ENV is set, or when the database
 * host is anything other than localhost, 127.0.0.1 or ::1. Every demo row starts with "[demo]"
 * (title, name or body), so the owner can tell it apart and `--remove` can find it again.
 * Re-running the seed replaces the previous demo rows; the owner's own rows are never changed.
 *
 * The rows are written through the app's own repositories (packages/db/src/demo), loaded as
 * TypeScript with Node's type stripping (Node 22.18+; older 22.x re-runs itself with the flag).
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function usage() {
  console.log(
    'Usage: node scripts/seed-demo.mjs [--remove] [--database-url <postgres://…local…>]\n' +
      'Seeds (or removes) labelled demo data in a LOCAL database. DATABASE_URL is used when\n' +
      '--database-url is not given.',
  )
}

function parseArgs(argv) {
  const out = { remove: false, databaseUrl: undefined, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--remove') out.remove = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--database-url') out.databaseUrl = argv[++i]
    else if (arg.startsWith('--database-url='))
      out.databaseUrl = arg.slice('--database-url='.length)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return out
}

/** The database name and host only; never the full URL (it could carry a password). */
function describeTarget(databaseUrl) {
  try {
    const u = new URL(databaseUrl)
    return `${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)}`
  } catch {
    return '(unparseable URL)'
  }
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    usage()
    return 2
  }
  if (args.help) {
    usage()
    return 0
  }

  // Older Node 22 releases need the flag for TypeScript imports: re-run with it once.
  if (!process.features?.typescript && !process.env.PH_SEED_DEMO_REEXEC) {
    const res = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ],
      { stdio: 'inherit', env: { ...process.env, PH_SEED_DEMO_REEXEC: '1' } },
    )
    return res.status ?? 1
  }

  // Silence the one-time "type stripping is experimental" notice; keep every other warning.
  process.removeAllListeners('warning')
  process.on('warning', (w) => {
    if (w.name !== 'ExperimentalWarning') console.warn(w)
  })

  const demo = await import(pathToFileURL(resolve(ROOT, 'packages/db/src/demo/index.ts')).href)
  const { createDb, withService } = await import(
    pathToFileURL(resolve(ROOT, 'packages/db/src/client.ts')).href
  )

  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL
  const refusal = demo.demoSeedRefusal(databaseUrl, {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
  })
  if (refusal) {
    console.error(`seed-demo: refusing to run: ${refusal}.`)
    console.error('Demo data is only for a local development database.')
    return 1
  }

  const db = createDb(databaseUrl, { max: 1, applicationName: 'personal-home-seed-demo' })
  try {
    const target = describeTarget(databaseUrl)
    if (args.remove) {
      const removed = await withService(db, (tx) => demo.removeDemoData(tx))
      console.log(`seed-demo: removed ${demo.demoTotal(removed)} demo rows from ${target}.`)
      printCounts(demo, removed)
      return 0
    }
    const result = await withService(db, (tx) => demo.seedDemoData(tx))
    if (demo.demoTotal(result.replaced) > 0) {
      console.log(`seed-demo: replaced ${demo.demoTotal(result.replaced)} earlier demo rows.`)
    }
    console.log(
      `seed-demo: seeded ${demo.demoTotal(result.counts)} demo rows into ${target} ` +
        `(owner timezone ${result.timezone}, today ${result.today}).`,
    )
    printCounts(demo, result.counts)
    if (result.skippedJournalDates.length > 0) {
      console.log(
        `seed-demo: kept your own journal entry on ${result.skippedJournalDates.join(', ')} (no demo entry written).`,
      )
    }
    console.log(
      'Every demo row starts with "[demo]". Remove them with: node scripts/seed-demo.mjs --remove',
    )
    return 0
  } finally {
    await db.end({ timeout: 5 })
  }
}

function printCounts(demo, counts) {
  for (const key of demo.DEMO_TABLES) {
    if (counts[key] > 0) console.log(`  ${key}: ${counts[key]}`)
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    // Messages only: never dump rows or connection strings.
    console.error(`seed-demo: failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
