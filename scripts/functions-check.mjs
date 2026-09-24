#!/usr/bin/env node
/**
 * Type-check, lint and test the Supabase Edge Functions with Deno.
 *
 *   node scripts/functions-check.mjs            # deno check + deno lint + deno test
 *   node scripts/functions-check.mjs --no-test  # skip the database-backed Deno tests
 *
 * Uses supabase/functions/deno.json (import map: workspace packages → their
 * src/index.ts, npm:postgres, npm:zod). `deno check` covers every function
 * entrypoint plus the shared code and the tests, so a Node-only API anywhere in
 * packages/{core,db,jobs,integrations}/src that a function imports fails here.
 *
 * The Deno tests need the local Postgres (scripts/local-db.mjs); this script
 * starts it if needed and passes the migrated template's name as
 * PH_TEST_TEMPLATE_DB. Deno downloads npm packages from registry.npmjs.org on
 * first use (set DENO_CERT if a TLS-intercepting proxy is in the way).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FUNCTIONS = join(ROOT, 'supabase', 'functions')
const CONFIG = join(FUNCTIONS, 'deno.json')
const args = new Set(process.argv.slice(2))
const runTests = !args.has('--no-test')

function findDeno() {
  const local = join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'deno.cmd' : 'deno',
  )
  if (existsSync(local)) return local
  const probe = spawnSync('deno', ['--version'], { encoding: 'utf8' })
  if (probe.status === 0) return 'deno'
  console.error('Deno not found: run `pnpm install` (the root devDependency provides it).')
  process.exit(1)
}

function run(cmd, argv, opts = {}) {
  const label = [relative(ROOT, cmd) || cmd, ...argv].join(' ')
  console.log(`\n$ ${label}`)
  const res = spawnSync(cmd, argv, { cwd: FUNCTIONS, stdio: 'inherit', ...opts })
  if (res.error) throw res.error
  if (res.status !== 0) {
    console.error(`\nfunctions-check: failed: ${label}`)
    process.exit(res.status ?? 1)
  }
}

/** All .ts files under supabase/functions (entrypoints, _shared, _tests), relative to it. */
function listTsFiles(dir = FUNCTIONS) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full))
    else if (name.endsWith('.ts')) out.push(relative(FUNCTIONS, full))
  }
  return out.sort()
}

function isTestFile(file) {
  return /(\.|_)test\.ts$/.test(file)
}

const deno = findDeno()
if (!existsSync(CONFIG)) {
  console.error(`missing ${relative(ROOT, CONFIG)}`)
  process.exit(1)
}

const files = listTsFiles()
const tests = files.filter(isTestFile)
if (files.length === 0) {
  console.error('no TypeScript files under supabase/functions')
  process.exit(1)
}

run(deno, ['check', '--config', CONFIG, ...files])
run(deno, ['lint', '--config', CONFIG])

if (!runTests) {
  console.log('\nfunctions-check: deno check + lint passed (tests skipped).')
  process.exit(0)
}
if (tests.length === 0) {
  console.log('\nfunctions-check: deno check + lint passed (no Deno tests found).')
  process.exit(0)
}

const localDb = join(ROOT, 'scripts', 'local-db.mjs')
const start = spawnSync(process.execPath, [localDb, 'start'], {
  encoding: 'utf8',
  env: process.env,
})
if (start.status !== 0) {
  console.error(`could not start the local database:\n${start.stderr || start.stdout}`)
  process.exit(1)
}
const tpl = spawnSync(process.execPath, [localDb, 'template'], {
  encoding: 'utf8',
  env: process.env,
})
if (tpl.status !== 0) {
  console.error(`could not build the test database template:\n${tpl.stderr || tpl.stdout}`)
  process.exit(1)
}
const templateUrl = tpl.stdout.trim().split('\n').pop() ?? ''
const templateDb = new URL(templateUrl).pathname.slice(1)
const port = process.env.PH_PG_PORT ?? '54329'

run(
  deno,
  [
    'test',
    '--config',
    CONFIG,
    '--allow-env',
    `--allow-net=127.0.0.1:${port},127.0.0.1:9`,
    '--allow-read',
    '--allow-run=node',
    ...tests,
  ],
  { env: { ...process.env, PH_TEST_TEMPLATE_DB: templateDb, PH_PG_PORT: port } },
)
console.log('\nfunctions-check: deno check, lint and tests passed.')
