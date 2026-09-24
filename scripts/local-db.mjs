#!/usr/bin/env node
/**
 * Throwaway local Postgres for tests and local development without Docker.
 *
 *   node scripts/local-db.mjs start     # init (once) and start on 127.0.0.1:$PH_PG_PORT (default 54329)
 *   node scripts/local-db.mjs stop
 *   node scripts/local-db.mjs status
 *   node scripts/local-db.mjs url       # print the superuser connection URL
 *   node scripts/local-db.mjs template  # (re)build database `ph_template` = Supabase shim + all migrations
 *   node scripts/local-db.mjs reset     # stop and delete the cluster
 *
 * If you already run `supabase start`, point tests at it with TEST_DATABASE_URL
 * instead; this script is only a convenience for machines without Docker.
 */
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
const BASE = join(ROOT, '.tmp', 'pg')
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

/** Rebuild `ph_template`: Supabase shim + every migration, in filename order. */
export function buildTemplate(name = 'ph_template') {
  start()
  psql(
    'postgres',
    `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}' and pid <> pg_backend_pid()`,
  )
  psql('postgres', `drop database if exists ${name}`)
  psql('postgres', `create database ${name}`)
  psql(name, join(ROOT, 'supabase', 'tests', 'shim', 'supabase_shim.sql'), { file: true })
  for (const file of migrationFiles()) psql(name, file, { file: true })
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
