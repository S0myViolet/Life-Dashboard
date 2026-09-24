/**
 * supabase/setup/10_schedule_dispatcher.sql (run once by the owner on the hosted
 * project) executed against local Postgres with STUBS for pg_cron, pg_net and
 * Supabase Vault, which the local cluster does not have. The stubs copy the
 * documented signatures (docs/research/supabase.md Q4), so this checks the
 * script's logic and call shapes — not the real extensions or a live project.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from './harness.ts'

const SETUP_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/setup/10_schedule_dispatcher.sql',
)
const SETUP = readFileSync(SETUP_FILE, 'utf8')
const URL_PLACEHOLDER = "'https://YOUR-PROJECT-REF.supabase.co'"
const SECRET_PLACEHOLDER = "'PASTE-THE-DISPATCHER_SECRET-VALUE-HERE'"

const STUBS = `
  create schema vault;
  create table vault.secrets (
    id uuid primary key default gen_random_uuid(),
    name text unique,
    description text,
    secret text not null,
    updated_at timestamptz not null default now()
  );
  create view vault.decrypted_secrets as
    select id, name, description, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
  returns uuid language sql as $$
    insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id
  $$;
  create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null)
  returns void language sql as $$
    update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
      description = coalesce(new_description, description), updated_at = now()
    where id = secret_id
  $$;

  create schema cron;
  create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null);
  create table cron.job_run_details (runid bigserial primary key, end_time timestamptz);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint
  language sql as $$
    insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
    returning jobid
  $$;

  create schema net;
  create table net.calls (
    id bigserial primary key, url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int
  );
  create function net.http_post(
    url text,
    body jsonb default '{}'::jsonb,
    params jsonb default '{}'::jsonb,
    headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds int default 2000
  ) returns bigint language sql as $$
    insert into net.calls (url, body, params, headers, timeout_milliseconds)
    values (url, body, params, headers, timeout_milliseconds) returning id
  $$;
`

/** The owner's edited copy, minus the extension statements the local cluster cannot run. */
function editedSetup(url: string, secret: string): string {
  const withoutExtensions = SETUP.replace(
    /^create extension if not exists (pg_cron|pg_net);$/gm,
    '',
  )
  expect(withoutExtensions).not.toContain('create extension')
  return withoutExtensions
    .replace(URL_PLACEHOLDER, `'${url.replace(/'/g, "''")}'`)
    .replace(SECRET_PLACEHOLDER, `'${secret.replace(/'/g, "''")}'`)
}

let t: TestDatabase
beforeAll(async () => {
  t = await createTestDatabase()
  await t.db.unsafe(STUBS)
})
afterAll(async () => {
  await t?.drop()
})

const SECRET = 'Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZg=='
const PROJECT = 'https://abcdefghijkl.supabase.co'

describe('10_schedule_dispatcher.sql', () => {
  it('contains the placeholders and both extensions', () => {
    expect(SETUP).toContain(URL_PLACEHOLDER)
    expect(SETUP).toContain(SECRET_PLACEHOLDER)
    expect(SETUP).toMatch(/^create extension if not exists pg_cron;$/m)
    expect(SETUP).toMatch(/^create extension if not exists pg_net;$/m)
  })

  it('refuses to run with the placeholders or a weak secret, without echoing values', async () => {
    const unedited = SETUP.replace(/^create extension if not exists (pg_cron|pg_net);$/gm, '')
    await expect(t.db.unsafe(unedited)).rejects.toThrow(/Set v_project_url/)
    await expect(
      t.db.unsafe(editedSetup(PROJECT, 'PASTE-THE-DISPATCHER_SECRET-VALUE-HERE')),
    ).rejects.toThrow(/Set v_dispatcher_secret/)
    const weak = 'too-short-secret'
    await expect(t.db.unsafe(editedSetup(PROJECT, weak))).rejects.toThrow(/Set v_dispatcher_secret/)
    await expect(t.db.unsafe(editedSetup(PROJECT, weak))).rejects.not.toThrow(new RegExp(weak))
    await expect(t.db.unsafe(editedSetup(`${PROJECT}/`, SECRET))).rejects.toThrow(
      /Set v_project_url/,
    )
    await expect(
      t.db.unsafe(editedSetup('http://abcdefghijkl.supabase.co', SECRET)),
    ).rejects.toThrow(/Set v_project_url/)
    const [n] = await t.db<{ secrets: number; jobs: number }[]>`
      select (select count(*)::int from vault.secrets) as secrets, (select count(*)::int from cron.job) as jobs
    `
    expect(n).toEqual({ secrets: 0, jobs: 0 })
  })

  it('stores the values in Vault and schedules a minute job that never contains the secret', async () => {
    await t.db.unsafe(editedSetup(PROJECT, SECRET))

    const secrets = await t.db<{ name: string; secret: string }[]>`
      select name, secret from vault.secrets order by name
    `
    expect([...secrets]).toEqual([
      { name: 'ph_dispatcher_secret', secret: SECRET },
      { name: 'ph_project_url', secret: PROJECT },
    ])

    const jobs = await t.db<{ jobname: string; schedule: string; command: string }[]>`
      select jobname, schedule, command from cron.job order by jobname
    `
    expect(jobs.map((j) => [j.jobname, j.schedule])).toEqual([
      ['ph-cron-history-cleanup', '17 3 * * *'],
      ['ph-dispatcher', '* * * * *'],
    ])
    for (const j of jobs) {
      expect(j.command).not.toContain(SECRET)
      expect(j.command).not.toContain(PROJECT)
    }

    // Run the cron command the way pg_cron would.
    await t.db.unsafe(jobs.find((j) => j.jobname === 'ph-dispatcher')!.command)
    const calls = await t.db<
      { url: string; headers: Record<string, string>; body: unknown; timeoutMilliseconds: number }[]
    >`select url, headers, body, timeout_milliseconds from net.calls order by id`
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${PROJECT}/functions/v1/dispatcher`)
    // (postgres.camel rewrites jsonb keys when reading; the stored key is x-dispatcher-secret.)
    const [raw] = await t.db<{ secretHeader: string; apikey: string | null }[]>`
      select headers ->> 'x-dispatcher-secret' as secret_header, headers ->> 'apikey' as apikey
      from net.calls order by id limit 1
    `
    expect(raw).toEqual({ secretHeader: SECRET, apikey: null })
    expect(calls[0]!.body).toEqual({ source: 'pg_cron' })
    expect(calls[0]!.timeoutMilliseconds).toBe(55_000)

    const cleanup = jobs.find((j) => j.jobname === 'ph-cron-history-cleanup')!.command
    await t.db`insert into cron.job_run_details (end_time) values (now() - interval '8 days'), (now())`
    await t.db.unsafe(cleanup)
    const [left] = await t.db<{ n: number }[]>`select count(*)::int as n from cron.job_run_details`
    expect(left?.n).toBe(1)
  })

  it('re-running rotates the secret in place and replaces the jobs', async () => {
    const rotated = 'bmV3LXNlY3JldC12YWx1ZS0wMTIzNDU2Nzg5YWJj'
    await t.db.unsafe(editedSetup(PROJECT, rotated))
    const [counts] = await t.db<{ secrets: number; jobs: number }[]>`
      select (select count(*)::int from vault.secrets) as secrets, (select count(*)::int from cron.job) as jobs
    `
    expect(counts).toEqual({ secrets: 2, jobs: 2 })
    const [job] = await t.db<
      { command: string }[]
    >`select command from cron.job where jobname = 'ph-dispatcher'`
    await t.db`truncate net.calls`
    await t.db.unsafe(job!.command)
    const [raw] = await t.db<{ secretHeader: string }[]>`
      select headers ->> 'x-dispatcher-secret' as secret_header from net.calls
    `
    expect(raw?.secretHeader).toBe(rotated)
  })
})
