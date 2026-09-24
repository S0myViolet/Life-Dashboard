#!/usr/bin/env node
/**
 * Throwaway local Postgres for tests and local development without Docker.
 *
 *   node scripts/local-db.mjs start     # init (once) and start on 127.0.0.1:$PH_PG_PORT (default 54329)
 *   node scripts/local-db.mjs stop
 *   node scripts/local-db.mjs status
 *   node scripts/local-db.mjs url       # print the superuser connection URL
 *   node scripts/local-db.mjs template  # build/reuse `ph_tpl_<hash>` = Supabase shim + all migrations
 *   node scripts/local-db.mjs reset     # stop and delete the cluster
 *
 * Any Postgres 15+ already listening on 127.0.0.1:$PH_PG_PORT (trust auth for user
 * `postgres`) is reused, so git worktrees share one server.
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chownSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.PH_PG_DIR ?? join(ROOT, '.tmp', 'pg')
const DATA = join(BASE, 'data')
const SOCK = join(BASE, 'socket')
const LOG = join(BASE, 'postgres.log')
const PORT = Number(process.env.PH_PG_PORT ?? 54329)
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

function findBinDir() {
  if (process.env.PG_BIN) return process.env.PG_BIN
  const res = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' })
  const candidates = []
  if (existsSync('/usr/lib/postgresql')) {
    for (const v of readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a))) {
      candidates.push(join('/usr/lib/postgresql', v, 'bin'))
    }
  }
  if (res.status === 0) candidates.push(res.stdout.trim())
  for (const dir of candidates) if (existsSync(join(dir, 'initdb'))) return dir
  throw new Error('Postgres binaries not found. Set PG_BIN or install PostgreSQL 15+.')
}

const BIN = findBinDir()

function run(cmd, args, opts = {}) {
  const bin = join(BIN, cmd)
  const [file, argv] = IS_ROOT ? ['runuser', ['-u', 'postgres', '--', bin, ...args]] : [bin, args]
  return execFileSync(file, argv, {
    stdio: opts.stdio ?? 'pipe',
    encoding: 'utf8',
    cwd: IS_ROOT ? '/tmp' : ROOT,
  })
}

function ensureOwnership(path) {
  if (!IS_ROOT) return
  const uid = Number(execFileSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).trim())
  const gid = Number(execFileSync('id', ['-g', 'postgres'], { encoding: 'utf8' }).trim())
  chownSync(path, uid, gid)
}

export function url(db = 'postgres') {
  return `postgres://postgres@127.0.0.1:${PORT}/${db}`
}

function isRunning() {
  if (!existsSync(join(DATA, 'PG_VERSION'))) return false
  const res = spawnSync(join(BIN, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(PORT)], {
    encoding: 'utf8',
  })
  return res.status === 0
}

export function start() {
  if (isRunning()) return url()
  mkdirSync(BASE, { recursive: true })
  ensureOwnership(join(ROOT, '.tmp'))
  ensureOwnership(BASE)
  if (!existsSync(join(DATA, 'PG_VERSION'))) {
    mkdirSync(DATA, { recursive: true })
    mkdirSync(SOCK, { recursive: true })
    ensureOwnership(DATA)
    ensureOwnership(SOCK)
    run('initdb', [
      '-D',
      DATA,
      '-U',
      'postgres',
      '--auth=trust',
      '--encoding=UTF8',
      '--locale=C.UTF-8',
    ])
    writeFileSync(
      join(DATA, 'postgresql.auto.conf'),
      [
        `listen_addresses = '127.0.0.1'`,
        `port = ${PORT}`,
        `unix_socket_directories = '${SOCK}'`,
        `max_connections = 200`,
        `fsync = off`,
        `synchronous_commit = off`,
        `full_page_writes = off`,
        `timezone = 'UTC'`,
        '',
      ].join('\n'),
    )
    ensureOwnership(join(DATA, 'postgresql.auto.conf'))
  }
  if (!isRunning()) {
    if (!existsSync(LOG)) {
      writeFileSync(LOG, '')
      ensureOwnership(LOG)
    }
    run('pg_ctl', ['-D', DATA, '-l', LOG, '-w', '-t', '30', 'start'])
  }
  return url()
}

export function stop() {
  if (existsSync(join(DATA, 'PG_VERSION'))) {
    try {
      run('pg_ctl', ['-D', DATA, '-m', 'fast', '-w', 'stop'])
    } catch {
      /* already stopped */
    }
  }
}

function psql(db, sqlOrFile, { file = false } = {}) {
  const args = [
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-h',
    '127.0.0.1',
    '-p',
    String(PORT),
    '-U',
    'postgres',
    '-d',
    db,
  ]
  if (file) args.push('-f', sqlOrFile)
  else args.push('-c', sqlOrFile)
  const res = spawnSync(join(BIN, 'psql'), args, { encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`psql failed${file ? ` for ${sqlOrFile}` : ''}:\n${res.stderr || res.stdout}`)
  }
  return res.stdout
}

export function migrationFiles() {
  const dir = join(ROOT, 'supabase', 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(dir, f))
}

function shimFile() {
  return join(ROOT, 'supabase', 'tests', 'shim', 'supabase_shim.sql')
}

/** Content hash of the shim + every migration, so identical schemas share one template. */
export function schemaHash() {
  const h = createHash('sha256')
  for (const file of [shimFile(), ...migrationFiles()]) {
    h.update(file.slice(ROOT.length))
    h.update('\0')
    h.update(readFileSync(file))
    h.update('\0')
  }
  return h.digest('hex').slice(0, 12)
}

function databaseExists(name) {
  const out = psql('postgres', `select 1 from pg_database where datname = '${name}'`)
  return out.includes('1')
}

/**
 * Build (or reuse) a template database = Supabase shim + all migrations.
 * The name is content-addressed (`ph_tpl_<hash>`), built under a new name and
 * renamed when complete, so parallel test runs never see a half-built template
 * or drop one another's template.
 */
export function buildTemplate(explicitName) {
  start()
  const name = explicitName ?? `ph_tpl_${schemaHash()}`
  if (!explicitName && databaseExists(name)) return url(name)
  const building = `${name}_b${process.pid}`
  psql('postgres', `drop database if exists ${building}`)
  psql('postgres', `create database ${building}`)
  try {
    psql(building, shimFile(), { file: true })
    for (const file of migrationFiles()) psql(building, file, { file: true })
  } catch (err) {
    psql('postgres', `drop database if exists ${building}`)
    throw err
  }
  try {
    if (explicitName) psql('postgres', `drop database if exists ${name} with (force)`)
    psql('postgres', `alter database ${building} rename to ${name}`)
  } catch (err) {
    // Another process finished the same template first: use theirs.
    psql('postgres', `drop database if exists ${building}`)
    if (!databaseExists(name)) throw err
  }
  return url(name)
}

const cmd = process.argv[2]
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    switch (cmd) {
      case 'start':
        console.log(start())
        break
      case 'stop':
        stop()
        break
      case 'status':
        console.log(isRunning() ? `running at ${url()}` : 'stopped')
        break
      case 'url':
        console.log(url(process.argv[3]))
        break
      case 'template':
        console.log(buildTemplate(process.argv[3]))
        break
      case 'template-name':
        console.log(`ph_tpl_${schemaHash()}`)
        break
      case 'reset':
        stop()
        rmSync(BASE, { recursive: true, force: true })
        break
      default:
        console.error('usage: local-db.mjs <start|stop|status|url|template|reset>')
        process.exit(2)
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
