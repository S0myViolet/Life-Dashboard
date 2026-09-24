-- Jobs: a lease-based queue in Postgres, recurring schedules, and published briefings.
--
-- Model (brief §7):
--   * private.jobs is the queue. A minute dispatcher (Supabase Cron → pg_net →
--     the `dispatcher` Edge Function) claims due jobs with FOR UPDATE SKIP LOCKED,
--     so parallel workers never hold the same job. Every claim issues a fresh
--     lease_token; heartbeat/complete/fail must present it, so a worker whose
--     lease expired and was reclaimed cannot overwrite the new holder's outcome.
--   * private.job_schedules holds recurring schedules. Their definitions live in
--     code (packages/core/src/jobs/schedules.ts) and are copied here by the
--     dispatcher. Owner-local times are converted to UTC instants in TypeScript
--     (packages/core/src/time) using owner_settings.timezone; SQL only stores instants.
--   * public.briefings holds one row per (kind, owner-local date). The owner can
--     read them; only the dispatcher's service connection writes them.
--
-- Clock: every queue function takes an optional p_now so the dispatcher (and the
-- tests) use one consistent clock for run_at/lease comparisons. It defaults to now().
--
-- Nothing here is reachable by anon or authenticated: the private schema has no
-- usage grant for them, and every table/function also revokes them explicitly.

-- Mirrors JOB_KINDS in packages/core/src/catalog.ts (checked by packages/db/test/jobs.test.ts).
create domain private.job_kind as text
  check (value in (
    'briefing.morning',
    'briefing.evening',
    'plan.daily_draft',
    'sync.google',
    'sync.microsoft',
    'sync.lunchflow',
    'sync.whoop',
    'sync.spotify',
    'sync.football',
    'sync.rss',
    'capture.summarize',
    'ai.reconcile',
    'push.deliver',
    'retention.purge'
  ));

-- ---------------------------------------------------------------------------
-- Recurring schedules
-- ---------------------------------------------------------------------------

create table private.job_schedules (
  name text primary key check (name ~ '^[a-z0-9_.-]{1,64}$'),
  kind private.job_kind not null,
  cadence text not null check (cadence in ('daily_local_time', 'interval')),
  -- Owner-local wall-clock time 'HH:MM', evaluated in owner_settings.timezone.
  local_time text check (local_time is null or local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  interval_seconds integer check (interval_seconds is null or interval_seconds between 60 and 604800),
  enabled boolean not null default false,
  -- When the schedule was (last) enabled. Occurrences due before this are never
  -- materialised, so a fresh install does not publish briefings it "missed".
  enabled_since timestamptz,
  -- Informational: when the next occurrence is due (UTC).
  next_run_at timestamptz,
  -- Due time of the most recent occurrence that was materialised as a job.
  last_occurrence_at timestamptz,
  -- Wall-clock time at which that job was enqueued.
  last_enqueued_at timestamptz,
  -- When a job from this schedule last completed successfully.
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_schedules_cadence_shape check (
    (cadence = 'daily_local_time' and local_time is not null and interval_seconds is null)
    or (cadence = 'interval' and interval_seconds is not null and local_time is null)
  ),
  constraint job_schedules_enabled_since check (not enabled or enabled_since is not null)
);

comment on table private.job_schedules is
  'Recurring job schedules. Definitions are code (core/jobs/schedules.ts), synced by the dispatcher.';

create trigger touch_updated_at before update on private.job_schedules
for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Queue
-- ---------------------------------------------------------------------------

create table private.jobs (
  id uuid primary key default gen_random_uuid(),
  kind private.job_kind not null,
  -- Identity of the unit of work (e.g. 'briefing.morning:2026-03-29'). Enqueueing
  -- an existing key is a no-op, for ever: keys are never reused.
  dedupe_key text check (
    dedupe_key is null or (length(dedupe_key) between 1 and 200 and dedupe_key ~ '^[!-~]+$')
  ),
  schedule_name text references private.job_schedules (name) on delete set null,
  -- Small structured input. Never raw mail, chat or journal text.
  payload jsonb not null default '{}'::jsonb check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 16384
  ),
  status text not null default 'queued' check (
    status in ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled')
  ),
  -- Earliest time the job may be claimed (next retry time after a failure).
  run_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 50),
  -- Worker that holds (or last held) the lease.
  lease_owner text check (lease_owner is null or length(lease_owner) between 1 and 200),
  lease_token uuid,
  lease_expires_at timestamptz,
  -- Sanitised by the caller (core sanitizeJobError); control characters and
  -- length are enforced again here.
  last_error text check (last_error is null or length(last_error) <= 1000),
  -- Small summary returned by the handler (counts/ids, no user content).
  result jsonb check (
    result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 16384)
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint jobs_lease_matches_status check (
    (status = 'running') = (lease_token is not null and lease_expires_at is not null and lease_owner is not null)
  ),
  constraint jobs_finished_matches_status check (
    (status in ('succeeded', 'dead', 'cancelled')) = (finished_at is not null)
  ),
  constraint jobs_attempts_within_max check (attempts <= max_attempts)
);

comment on table private.jobs is
  'Background job queue. Claimed with leases by the dispatcher Edge Function; see private.claim_jobs.';

create unique index jobs_dedupe_key_key on private.jobs (dedupe_key) where dedupe_key is not null;
create index jobs_claimable_idx on private.jobs (run_at) where status in ('queued', 'failed');
create index jobs_lease_expiry_idx on private.jobs (lease_expires_at) where status = 'running';
create index jobs_schedule_idx on private.jobs (schedule_name) where schedule_name is not null;

create trigger touch_updated_at before update on private.jobs
for each row execute function private.touch_updated_at();

-- Enqueue a job. Idempotent on p_dedupe_key: when a job with that key already
-- exists (in any status), nothing is inserted and that job is returned with
-- created = false. Safe under concurrency (the unique index serialises inserts).
create function private.enqueue_job(
  p_kind text,
  p_payload jsonb default '{}'::jsonb,
  p_dedupe_key text default null,
  p_run_at timestamptz default null,
  p_max_attempts integer default 5,
  p_schedule_name text default null,
  p_now timestamptz default null
) returns table (job_id uuid, created boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_id uuid;
  v_kind text;
begin
  insert into private.jobs (kind, payload, dedupe_key, run_at, max_attempts, schedule_name)
  values (
    p_kind,
    coalesce(p_payload, '{}'::jsonb),
    p_dedupe_key,
    coalesce(p_run_at, v_now),
    coalesce(p_max_attempts, 5),
    p_schedule_name
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;

  if v_id is not null then
    return query select v_id, true;
    return;
  end if;

  -- The key exists. In READ COMMITTED this statement sees the committed row that
  -- made the insert a no-op.
  select j.id, j.kind into v_id, v_kind from private.jobs j where j.dedupe_key = p_dedupe_key;
  if v_id is null then
    raise exception 'enqueue_job: conflicting job for key % is not visible', p_dedupe_key;
  end if;
  if v_kind <> p_kind then
    raise exception 'enqueue_job: dedupe key % already belongs to a % job', p_dedupe_key, v_kind
      using errcode = '23505';
  end if;
  return query select v_id, false;
end
$$;

-- Mark jobs dead whose lease expired during their final attempt (the worker died
-- or timed out without reporting). Returned so the dispatcher can run the
-- handler's onDead hook (e.g. mark a briefing as failed rather than "preparing").
create function private.reap_expired_jobs(
  p_kinds text[] default null,
  p_now timestamptz default null
) returns setof private.jobs
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
begin
  return query
  with expired as (
    select j.id
    from private.jobs j
    where j.status = 'running'
      and j.lease_expires_at <= v_now
      and j.attempts >= j.max_attempts
      and (p_kinds is null or j.kind = any (p_kinds))
    for update skip locked
  )
  update private.jobs j
  set status = 'dead',
      lease_token = null,
      lease_expires_at = null,
      last_error = 'Lease expired during the final attempt',
      finished_at = v_now
  from expired e
  where j.id = e.id
  returning j.*;
end
$$;

-- Claim up to p_limit due jobs for p_worker. A job is due when it is queued or
-- failed with run_at <= now, or running with an expired lease (its worker died
-- or overran; it still has attempts left). Each claim increments attempts and
-- issues a new lease token. SKIP LOCKED lets concurrent claimers take disjoint rows.
create function private.claim_jobs(
  p_worker text,
  p_limit integer,
  p_lease_ms integer,
  p_kinds text[] default null,
  p_now timestamptz default null
) returns setof private.jobs
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
begin
  if p_worker is null or length(p_worker) not between 1 and 200 then
    raise exception 'claim_jobs: invalid worker id' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'claim_jobs: limit must be between 1 and 100' using errcode = '22023';
  end if;
  if p_lease_ms is null or p_lease_ms not between 100 and 3600000 then
    raise exception 'claim_jobs: lease must be between 100 ms and 1 hour' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select j.id
    from private.jobs j
    where (
        (j.status in ('queued', 'failed') and j.run_at <= v_now)
        or (j.status = 'running' and j.lease_expires_at <= v_now)
      )
      and j.attempts < j.max_attempts
      and (p_kinds is null or j.kind = any (p_kinds))
    order by j.run_at, j.created_at, j.id
    limit p_limit
    for update skip locked
  )
  update private.jobs j
  set status = 'running',
      attempts = j.attempts + 1,
      lease_owner = p_worker,
      lease_token = gen_random_uuid(),
      lease_expires_at = v_now + p_lease_ms * interval '1 millisecond'
  from candidates c
  where j.id = c.id
  returning j.*;
end
$$;

-- Extend a lease. Returns the new expiry, or null when the token no longer holds
-- the job (reclaimed by another worker, or already finished).
create function private.heartbeat_job(
  p_id uuid,
  p_token uuid,
  p_lease_ms integer,
  p_now timestamptz default null
) returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_expires timestamptz;
begin
  if p_lease_ms is null or p_lease_ms not between 100 and 3600000 then
    raise exception 'heartbeat_job: lease must be between 100 ms and 1 hour' using errcode = '22023';
  end if;
  update private.jobs j
  set lease_expires_at = greatest(j.lease_expires_at, v_now + p_lease_ms * interval '1 millisecond')
  where j.id = p_id and j.status = 'running' and j.lease_token = p_token
  returning j.lease_expires_at into v_expires;
  return v_expires;
end
$$;

-- Mark a job succeeded. Returns false (and changes nothing) when p_token no
-- longer holds the lease.
create function private.complete_job(
  p_id uuid,
  p_token uuid,
  p_result jsonb default null,
  p_now timestamptz default null
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_schedule text;
  v_found boolean;
begin
  update private.jobs j
  set status = 'succeeded',
      result = p_result,
      lease_token = null,
      lease_expires_at = null,
      finished_at = v_now
  where j.id = p_id and j.status = 'running' and j.lease_token = p_token
  returning j.schedule_name into v_schedule;
  v_found := found;

  if v_found and v_schedule is not null then
    update private.job_schedules s
    set last_success_at = greatest(coalesce(s.last_success_at, '-infinity'::timestamptz), v_now)
    where s.name = v_schedule;
  end if;
  return v_found;
end
$$;

-- Record a failed attempt. Returns 'failed' (will retry at run_at), 'dead' (out
-- of attempts or not retryable), or null when p_token no longer holds the lease.
-- p_retry_at (e.g. from Retry-After, combined with backoff by the caller) is
-- honoured, clamped to [now, now + 24h]. Without it a plain exponential backoff
-- (30 s doubling, 1 h cap) applies.
create function private.fail_job(
  p_id uuid,
  p_token uuid,
  p_error text,
  p_retry_at timestamptz default null,
  p_retryable boolean default true,
  p_now timestamptz default null
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_attempts integer;
  v_max integer;
  v_error text;
  v_run_at timestamptz;
begin
  v_error := left(
    btrim(regexp_replace(coalesce(nullif(p_error, ''), 'Unknown error'), '[[:cntrl:]]+', ' ', 'g')),
    1000
  );

  select j.attempts, j.max_attempts into v_attempts, v_max
  from private.jobs j
  where j.id = p_id and j.status = 'running' and j.lease_token = p_token
  for update;
  if not found then
    return null;
  end if;

  if not coalesce(p_retryable, true) or v_attempts >= v_max then
    update private.jobs j
    set status = 'dead',
        last_error = v_error,
        lease_token = null,
        lease_expires_at = null,
        finished_at = v_now
    where j.id = p_id;
    return 'dead';
  end if;

  v_run_at := coalesce(
    p_retry_at,
    v_now + least(3600, 30 * power(2, greatest(v_attempts - 1, 0))) * interval '1 second'
  );
  v_run_at := least(greatest(v_run_at, v_now), v_now + interval '24 hours');

  update private.jobs j
  set status = 'failed',
      last_error = v_error,
      run_at = v_run_at,
      lease_token = null,
      lease_expires_at = null
  where j.id = p_id;
  return 'failed';
end
$$;

-- Lock everything down: service connection only.
revoke all on table private.jobs, private.job_schedules from public, anon, authenticated;
grant select, insert, update, delete on table private.jobs, private.job_schedules to service_role;

revoke all on function private.enqueue_job(text, jsonb, text, timestamptz, integer, text, timestamptz)
  from public, anon, authenticated;
revoke all on function private.reap_expired_jobs(text[], timestamptz) from public, anon, authenticated;
revoke all on function private.claim_jobs(text, integer, integer, text[], timestamptz)
  from public, anon, authenticated;
revoke all on function private.heartbeat_job(uuid, uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function private.complete_job(uuid, uuid, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function private.fail_job(uuid, uuid, text, timestamptz, boolean, timestamptz)
  from public, anon, authenticated;

grant execute on function
  private.enqueue_job(text, jsonb, text, timestamptz, integer, text, timestamptz),
  private.reap_expired_jobs(text[], timestamptz),
  private.claim_jobs(text, integer, integer, text[], timestamptz),
  private.heartbeat_job(uuid, uuid, integer, timestamptz),
  private.complete_job(uuid, uuid, jsonb, timestamptz),
  private.fail_job(uuid, uuid, text, timestamptz, boolean, timestamptz)
to service_role;

-- ---------------------------------------------------------------------------
-- Briefings
-- ---------------------------------------------------------------------------

create table public.briefings (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('morning', 'evening')),
  -- Owner-local date the briefing belongs to (in `timezone`).
  local_date date not null,
  -- IANA timezone used to compute local_date/scheduled_for (owner_settings.timezone at the time).
  timezone text not null check (length(timezone) between 1 and 64),
  -- The UTC instant of 11:00 / 22:00 local on local_date.
  scheduled_for timestamptz not null,
  status text not null default 'preparing' check (status in ('preparing', 'published', 'failed')),
  published_at timestamptz,
  -- Published more than 30 minutes after scheduled_for (e.g. after an outage).
  is_late boolean not null default false,
  -- Whether a push notification should go out (M2). Never for late briefings.
  notify boolean not null default false,
  content jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  source_freshness jsonb not null default '{}'::jsonb check (jsonb_typeof(source_freshness) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One briefing per kind per owner-local date, across retries, concurrency,
  -- DST and timezone changes (single-owner app, so no owner column is needed).
  constraint briefings_kind_local_date_key unique (kind, local_date),
  constraint briefings_published_at_matches_status check ((status = 'published') = (published_at is not null)),
  constraint briefings_notify_only_on_time check (not notify or (status = 'published' and not is_late))
);

comment on table public.briefings is
  'Morning briefing / evening review, one per kind per owner-local date. Owner reads; the dispatcher writes.';

create index briefings_recent_idx on public.briefings (local_date desc, kind);

select private.secure_owner_table('public.briefings');

-- Stricter than the default owner policy: the owner may read, only the service
-- connection (dispatcher) writes.
revoke insert, update, delete on public.briefings from authenticated;
drop policy owner_all on public.briefings;
create policy owner_read on public.briefings
  as permissive for select to authenticated
  using ((select public.is_owner()));
