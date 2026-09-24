/**
 * Playwright global setup:
 *   1. build (or reuse) the migrated template database via scripts/local-db.mjs `template`;
 *   2. clone it with `createdb -T` into a throwaway ph_e2e_* database;
 *   3. seed the dashboard owner and a second, non-owner auth user;
 *   4. `next build` (skip with PH_E2E_SKIP_BUILD=1) and `next start` on port 3200 with the
 *      test-only sign-in enabled (PH_E2E_AUTH=1 + a random PH_E2E_AUTH_SECRET).
 * Returns the teardown: stop the server and drop the database it created.
 *
 * Values the tests need are passed through process.env (inherited by workers).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FullConfig } from '@playwright/test'

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = resolve(WEB, '..', '..')
const PG_PORT = process.env.PH_PG_PORT ?? '54329'
const OWNER_EMAIL = 'owner@example.com'
const STRANGER_EMAIL = 'stranger@example.com'

function run(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status}):\n${res.stderr || res.stdout}`)
  }
  return res.stdout
}

function psql(db: string, sql: string): string {
  return run('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', PG_PORT, '-U', 'postgres', '-d', db, '-c', sql])
}

async function waitForServer(url: string, server: ChildProcess, timeoutMs: number) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (server.exitCode !== null) throw new Error(`next start exited with code ${server.exitCode}`)
    try {
      const res = await fetch(url, { redirect: 'manual' })
      if (res.status === 200) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Server did not become ready at ${url} within ${timeoutMs} ms`)
}

async function portInUse(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = String(config.projects[0]?.use.baseURL ?? 'http://localhost:3200')
  const port = Number(new URL(baseURL).port)
  if (await portInUse(port)) {
    throw new Error(`Port ${port} is already in use. Stop that server or set PH_E2E_PORT.`)
  }

  // 1–2. Template (shim + all migrations) and a fresh clone of it.
  const templateUrl = run(process.execPath, ['scripts/local-db.mjs', 'template']).trim().split('\n').pop()!
  const template = new URL(templateUrl).pathname.slice(1)
  const database = `ph_e2e_${randomBytes(5).toString('hex')}`
  run('createdb', ['-h', '127.0.0.1', '-p', PG_PORT, '-U', 'postgres', '-T', template, database])
  const databaseUrl = `postgres://postgres@127.0.0.1:${PG_PORT}/${database}`

  const dropDatabase = () => {
    try {
      psql('postgres', `drop database if exists ${database} with (force)`)
    } catch (error) {
      console.error(`Could not drop ${database}:`, error)
    }
  }

  let server: ChildProcess | undefined
  try {
    // 3. Owner (claimed through the same SQL the auth callback uses) and a stranger.
    const ownerId = randomUUID()
    const strangerId = randomUUID()
    psql(
      database,
      `insert into auth.users (id, email, email_confirmed_at) values
         ('${ownerId}', '${OWNER_EMAIL}', now()), ('${strangerId}', '${STRANGER_EMAIL}', now());
       select private.claim_owner('${ownerId}', '${OWNER_EMAIL}');`,
    )

    const secret = randomBytes(32).toString('hex')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      PH_E2E_AUTH: '1',
      PH_E2E_AUTH_SECRET: secret,
      DATABASE_URL: databaseUrl,
      APP_URL: baseURL,
      NEXT_TELEMETRY_DISABLED: '1',
    }
    // The test sign-in refuses to run on Vercel; make sure nothing here looks like it.
    delete env.VERCEL
    delete env.VERCEL_ENV

    // 4. Build and start a production server.
    const nextBin = resolve(WEB, 'node_modules', '.bin', 'next')
    if (process.env.PH_E2E_SKIP_BUILD !== '1') {
      console.log('[e2e] next build …')
      run(nextBin, ['build'], { cwd: WEB, env })
    }
    console.log(`[e2e] next start on ${baseURL} (database ${database})`)
    server = spawn(nextBin, ['start', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: WEB,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const logs: string[] = []
    server.stdout?.on('data', (d: Buffer) => logs.push(d.toString()))
    server.stderr?.on('data', (d: Buffer) => logs.push(d.toString()))
    try {
      await waitForServer(`http://127.0.0.1:${port}/login`, server, 60_000)
    } catch (error) {
      console.error(logs.join(''))
      throw error
    }

    process.env.PH_E2E_AUTH_SECRET = secret
    process.env.PH_E2E_DATABASE = database
    process.env.PH_E2E_OWNER_ID = ownerId
    process.env.PH_E2E_OWNER_EMAIL = OWNER_EMAIL
    process.env.PH_E2E_STRANGER_ID = strangerId
    process.env.PH_E2E_STRANGER_EMAIL = STRANGER_EMAIL
  } catch (error) {
    if (server?.pid) process.kill(-server.pid, 'SIGTERM')
    dropDatabase()
    throw error
  }

  const running = server
  return async () => {
    if (running.pid && running.exitCode === null) {
      try {
        process.kill(-running.pid, 'SIGTERM')
      } catch {
        // already gone
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    dropDatabase()
  }
}
