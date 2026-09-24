-- AI budget: monthly spending reservations, reconciliation and a usage audit trail.
--
-- Brief §8: before a model request, atomically reserve a conservative maximum cost; reconcile
-- against returned usage; keep reservations for ambiguous failures; warn at 80%; stop new model
-- calls at the cap while everything else keeps working. §10 Budget: concurrent requests cannot
-- bypass reservations.
--
-- Money here is GBP micros (1 GBP = 1_000_000) because single requests cost fractions of a penny.
-- The budget period is the owner-local calendar month 'YYYY-MM', computed by the caller from
-- owner_settings.timezone (packages/core aiBudgetPeriod).
--
-- Invariant, per period:
--   committed_micros = sum(reserved_micros where status in ('reserved','ambiguous'))
--                    + sum(actual_micros   where status = 'reconciled')
-- The row lock on private.ai_budget_periods serialises every change to committed_micros.
-- Lock order is always ai_usage row → ai_budget_periods row (reserve only takes the latter),
-- so the functions cannot deadlock one another.

-- ---------------------------------------------------------------------------
-- Settings (singleton)
-- ---------------------------------------------------------------------------

create table private.ai_budget_settings (
  singleton boolean primary key default true check (singleton),
  -- £15.00 by default (brief §8). Upper bound is a sanity limit, not a target.
  monthly_cap_micros bigint not null default 15000000
    check (monthly_cap_micros between 0 and 1000000000),
  warn_ratio numeric(4, 3) not null default 0.800 check (warn_ratio > 0 and warn_ratio <= 1),
  -- GBP per USD used to convert provider prices. 1.00 overestimates GBP at every historical
  -- rate (sterling has never traded below parity). Values under 0.5 would understate spend.
  usd_to_gbp_rate numeric(10, 6) not null default 1.000000
    check (usd_to_gbp_rate >= 0.5 and usd_to_gbp_rate <= 5),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger touch_updated_at before update on private.ai_budget_settings
for each row execute function private.touch_updated_at();

insert into private.ai_budget_settings (singleton) values (true) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Periods
-- ---------------------------------------------------------------------------

create table private.ai_budget_periods (
  period text primary key check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- Cap in force at the latest reservation attempt for this period.
  cap_micros bigint not null check (cap_micros >= 0),
  -- Outstanding reservations + ambiguous reservations + reconciled actuals.
  committed_micros bigint not null default 0 check (committed_micros >= 0),
  -- Reservations refused because of the cap (or because AI was disabled).
  denied_count integer not null default 0 check (denied_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger touch_updated_at before update on private.ai_budget_periods
for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Usage ledger (owner can read; only service functions write)
-- ---------------------------------------------------------------------------

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  period text not null references private.ai_budget_periods (period),
  purpose text not null check (purpose ~ '^[a-z][a-z0-9_.]{0,63}$'),
  model text not null check (model ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  source_types text[] not null default '{}'
    check (
      cardinality(source_types) <= 32
      and array_position(source_types, null) is null
      and array_to_string(source_types, ',') ~ '^([a-z][a-z_]{0,39}(,[a-z][a-z_]{0,39})*)?$'
      -- Never sent to a model (brief §5/§10); enforced here as well as in application code.
      and not (source_types && array['spotify', 'market_quote']::text[])
    ),
  status text not null default 'reserved'
    check (status in ('reserved', 'reconciled', 'released', 'ambiguous')),
  reserved_micros bigint not null check (reserved_micros > 0),
  actual_micros bigint check (actual_micros >= 0),
  usd_to_gbp_rate numeric(10, 6) not null check (usd_to_gbp_rate > 0),
  -- Token counts, audio seconds and request limits only: a flat object of non-negative numbers,
  -- so prompt or response text cannot be stored here.
  usage jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(usage) = 'object'
      and pg_column_size(usage) <= 4096
      and not jsonb_path_exists(usage, 'strict $.* ? (@.type() != "number" || @ < 0)')
    ),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_.:-]{1,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reconciled_at timestamptz,
  constraint ai_usage_reconciled_has_actual
    check ((status = 'reconciled') = (actual_micros is not null and reconciled_at is not null))
);

comment on table public.ai_usage is
  'One row per AI request reservation. Written only by private.ai_* functions (service role); the owner can read it.';

create index ai_usage_period_status_idx on public.ai_usage (period, status);
create index ai_usage_reserved_created_idx on public.ai_usage (created_at) where status = 'reserved';

select private.secure_owner_table('public.ai_usage');

-- Tighten to read-only for the owner: the ledger is written only by the service functions below.
drop policy owner_all on public.ai_usage;
create policy owner_select on public.ai_usage as permissive for select to authenticated
  using ((select public.is_owner()));
revoke insert, update, delete, truncate, references, trigger on public.ai_usage from authenticated;

-- ---------------------------------------------------------------------------
-- Service functions
-- ---------------------------------------------------------------------------

-- Reserve `p_max_micros` for one request. Atomic under concurrency: the period row lock
-- serialises reservations, and a reservation is refused if it would take committed above the cap.
create function private.ai_reserve(
  p_period text,
  p_purpose text,
  p_model text,
  p_source_types text[],
  p_max_micros bigint,
  p_usd_to_gbp_rate numeric,
  p_usage jsonb default '{}'::jsonb
) returns table (
  allowed boolean,
  reason text,
  reservation_id uuid,
  cap_micros bigint,
  committed_micros bigint,
  remaining_micros bigint,
  warn boolean
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  s private.ai_budget_settings%rowtype;
  v_committed bigint;
  v_cap bigint;
  v_id uuid;
begin
  if p_period is null or p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid budget period' using errcode = '22023';
  end if;
  if p_max_micros is null or p_max_micros <= 0 then
    raise exception 'reservation must be a positive amount' using errcode = '22023';
  end if;
  if p_usd_to_gbp_rate is null or p_usd_to_gbp_rate <= 0 then
    raise exception 'conversion rate must be positive' using errcode = '22023';
  end if;

  select * into s from private.ai_budget_settings st where st.singleton;
  if not found then
    raise exception 'AI budget settings are missing' using errcode = 'P0002';
  end if;
  v_cap := s.monthly_cap_micros;

  insert into private.ai_budget_periods (period, cap_micros)
  values (p_period, v_cap)
  on conflict (period) do nothing;

  -- The serialisation point.
  select bp.committed_micros into v_committed
  from private.ai_budget_periods bp
  where bp.period = p_period
  for update;

  if not s.enabled or v_committed + p_max_micros > v_cap then
    update private.ai_budget_periods bp
    set denied_count = bp.denied_count + 1, cap_micros = v_cap
    where bp.period = p_period;
    return query select
      false,
      case when s.enabled then 'cap_reached' else 'disabled' end,
      null::uuid,
      v_cap,
      v_committed,
      greatest(v_cap - v_committed, 0),
      v_committed >= v_cap * s.warn_ratio;
    return;
  end if;

  update private.ai_budget_periods bp
  set committed_micros = bp.committed_micros + p_max_micros, cap_micros = v_cap
  where bp.period = p_period
  returning bp.committed_micros into v_committed;

  insert into public.ai_usage (
    period, purpose, model, source_types, status, reserved_micros, usd_to_gbp_rate, usage
  ) values (
    p_period, p_purpose, p_model, coalesce(p_source_types, '{}'), 'reserved', p_max_micros,
    p_usd_to_gbp_rate, coalesce(p_usage, '{}'::jsonb)
  )
  returning id into v_id;

  return query select
    true,
    'reserved'::text,
    v_id,
    v_cap,
    v_committed,
    greatest(v_cap - v_committed, 0),
    v_committed >= v_cap * s.warn_ratio;
end
$$;

-- Record the actual cost of a request that completed. Actual may be lower (frees headroom) or
-- higher (recorded honestly; committed may then exceed the cap and further reservations are
-- refused). Works from 'reserved' or 'ambiguous'. Re-reconciling is a no-op.
create function private.ai_reconcile(
  p_id uuid,
  p_actual_micros bigint,
  p_usage jsonb default '{}'::jsonb,
  p_error_code text default null
) returns table (
  status text,
  previous_status text,
  period text,
  reserved_micros bigint,
  actual_micros bigint,
  committed_micros bigint
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  u public.ai_usage%rowtype;
  v_committed bigint;
begin
  if p_actual_micros is null or p_actual_micros < 0 then
    raise exception 'actual cost must be zero or more' using errcode = '22023';
  end if;

  select * into u from public.ai_usage au where au.id = p_id for update;
  if not found then
    raise exception 'unknown AI reservation' using errcode = 'P0002';
  end if;

  if u.status = 'reconciled' then
    select bp.committed_micros into v_committed
    from private.ai_budget_periods bp where bp.period = u.period;
    return query select u.status, u.status, u.period, u.reserved_micros, u.actual_micros, v_committed;
    return;
  end if;
  if u.status = 'released' then
    raise exception 'a released reservation cannot be reconciled' using errcode = '55000';
  end if;

  update private.ai_budget_periods bp
  set committed_micros = bp.committed_micros - u.reserved_micros + p_actual_micros
  where bp.period = u.period
  returning bp.committed_micros into v_committed;

  update public.ai_usage au
  set status = 'reconciled',
      actual_micros = p_actual_micros,
      usage = au.usage || coalesce(p_usage, '{}'::jsonb),
      error_code = coalesce(p_error_code, au.error_code),
      reconciled_at = now()
  where au.id = p_id;

  return query select 'reconciled'::text, u.status, u.period, u.reserved_micros, p_actual_micros, v_committed;
end
$$;

-- The request may or may not have been processed (timeout, reset after send, 5xx, unreadable
-- response). The full reservation stays counted until someone reconciles it.
create function private.ai_mark_ambiguous(
  p_id uuid,
  p_error_code text,
  p_usage jsonb default '{}'::jsonb
) returns table (status text, previous_status text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  u public.ai_usage%rowtype;
begin
  select * into u from public.ai_usage au where au.id = p_id for update;
  if not found then
    raise exception 'unknown AI reservation' using errcode = 'P0002';
  end if;
  if u.status <> 'reserved' then
    -- Already ambiguous, reconciled or released: leave it as it is.
    return query select u.status, u.status;
    return;
  end if;
  update public.ai_usage au
  set status = 'ambiguous',
      error_code = coalesce(p_error_code, au.error_code),
      usage = au.usage || coalesce(p_usage, '{}'::jsonb)
  where au.id = p_id;
  return query select 'ambiguous'::text, u.status;
end
$$;

-- Give back a reservation for a request that provably never reached the provider (validation
-- failure before sending, connection refused / DNS failure before any bytes were written).
-- Ambiguous reservations are never released.
create function private.ai_release(p_id uuid, p_error_code text)
returns table (status text, previous_status text, committed_micros bigint)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  u public.ai_usage%rowtype;
  v_committed bigint;
begin
  select * into u from public.ai_usage au where au.id = p_id for update;
  if not found then
    raise exception 'unknown AI reservation' using errcode = 'P0002';
  end if;
  if u.status = 'released' then
    select bp.committed_micros into v_committed
    from private.ai_budget_periods bp where bp.period = u.period;
    return query select u.status, u.status, v_committed;
    return;
  end if;
  if u.status <> 'reserved' then
    raise exception 'only an unsent reservation can be released (status %)', u.status
      using errcode = '55000';
  end if;

  update private.ai_budget_periods bp
  set committed_micros = bp.committed_micros - u.reserved_micros
  where bp.period = u.period
  returning bp.committed_micros into v_committed;

  update public.ai_usage au
  set status = 'released', error_code = coalesce(p_error_code, au.error_code)
  where au.id = p_id;

  return query select 'released'::text, u.status, v_committed;
end
$$;

-- Reservations still 'reserved' after `p_older_than` belong to a worker that died mid-request.
-- They become 'ambiguous' (still fully counted), never released.
create function private.ai_sweep_stale(
  p_older_than interval default interval '24 hours',
  p_now timestamptz default now()
) returns integer
language plpgsql
set search_path = ''
as $$
declare
  n integer;
begin
  if p_older_than is null or p_older_than < interval '1 hour' then
    raise exception 'stale threshold must be at least one hour' using errcode = '22023';
  end if;
  with stale as (
    select au.id from public.ai_usage au
    where au.status = 'reserved' and au.created_at < p_now - p_older_than
    for update skip locked
  )
  update public.ai_usage au
  set status = 'ambiguous', error_code = coalesce(au.error_code, 'stale_reservation')
  from stale
  where au.id = stale.id;
  get diagnostics n = row_count;
  return n;
end
$$;

-- Budget summary for one period (Settings). Service-side; the owner reads it through
-- public.ai_budget_status below.
create function private.ai_budget_status(p_period text)
returns table (
  period text,
  enabled boolean,
  cap_micros bigint,
  warn_ratio numeric,
  usd_to_gbp_rate numeric,
  committed_micros bigint,
  remaining_micros bigint,
  reconciled_micros bigint,
  reconciled_count integer,
  outstanding_micros bigint,
  outstanding_count integer,
  ambiguous_micros bigint,
  ambiguous_count integer,
  released_count integer,
  denied_count integer,
  warn boolean,
  exhausted boolean
)
language sql
stable
set search_path = ''
as $$
  with s as (
    select st.* from private.ai_budget_settings st where st.singleton
  ),
  p as (
    select bp.committed_micros, bp.denied_count
    from private.ai_budget_periods bp where bp.period = p_period
  ),
  u as (
    select
      coalesce(sum(au.actual_micros) filter (where au.status = 'reconciled'), 0)::bigint as reconciled_micros,
      (count(*) filter (where au.status = 'reconciled'))::integer as reconciled_count,
      coalesce(sum(au.reserved_micros) filter (where au.status = 'reserved'), 0)::bigint as outstanding_micros,
      (count(*) filter (where au.status = 'reserved'))::integer as outstanding_count,
      coalesce(sum(au.reserved_micros) filter (where au.status = 'ambiguous'), 0)::bigint as ambiguous_micros,
      (count(*) filter (where au.status = 'ambiguous'))::integer as ambiguous_count,
      (count(*) filter (where au.status = 'released'))::integer as released_count
    from public.ai_usage au where au.period = p_period
  )
  select
    p_period,
    s.enabled,
    s.monthly_cap_micros,
    s.warn_ratio,
    s.usd_to_gbp_rate,
    coalesce(p.committed_micros, 0)::bigint,
    greatest(s.monthly_cap_micros - coalesce(p.committed_micros, 0), 0)::bigint,
    u.reconciled_micros,
    u.reconciled_count,
    u.outstanding_micros,
    u.outstanding_count,
    u.ambiguous_micros,
    u.ambiguous_count,
    u.released_count,
    coalesce(p.denied_count, 0),
    coalesce(p.committed_micros, 0) >= s.monthly_cap_micros * s.warn_ratio,
    coalesce(p.committed_micros, 0) >= s.monthly_cap_micros
  from s cross join u left join p on true
$$;

revoke all on function private.ai_reserve(text, text, text, text[], bigint, numeric, jsonb) from public, anon, authenticated;
revoke all on function private.ai_reconcile(uuid, bigint, jsonb, text) from public, anon, authenticated;
revoke all on function private.ai_mark_ambiguous(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function private.ai_release(uuid, text) from public, anon, authenticated;
revoke all on function private.ai_sweep_stale(interval, timestamptz) from public, anon, authenticated;
revoke all on function private.ai_budget_status(text) from public, anon, authenticated;
grant execute on function private.ai_reserve(text, text, text, text[], bigint, numeric, jsonb) to service_role;
grant execute on function private.ai_reconcile(uuid, bigint, jsonb, text) to service_role;
grant execute on function private.ai_mark_ambiguous(uuid, text, jsonb) to service_role;
grant execute on function private.ai_release(uuid, text) to service_role;
grant execute on function private.ai_sweep_stale(interval, timestamptz) to service_role;
grant execute on function private.ai_budget_status(text) to service_role;

revoke all on table private.ai_budget_settings, private.ai_budget_periods from public, anon, authenticated;
grant all on table private.ai_budget_settings, private.ai_budget_periods to service_role;

-- ---------------------------------------------------------------------------
-- Owner read path
-- ---------------------------------------------------------------------------

-- The owner's Settings page reads the budget through withOwner (RLS path). The private tables
-- stay unreachable; this definer function checks ownership and returns the summary only.
create function public.ai_budget_status(p_period text)
returns table (
  period text,
  enabled boolean,
  cap_micros bigint,
  warn_ratio numeric,
  usd_to_gbp_rate numeric,
  committed_micros bigint,
  remaining_micros bigint,
  reconciled_micros bigint,
  reconciled_count integer,
  outstanding_micros bigint,
  outstanding_count integer,
  ambiguous_micros bigint,
  ambiguous_count integer,
  released_count integer,
  denied_count integer,
  warn boolean,
  exhausted boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_owner() then
    raise exception 'only the dashboard owner can read the AI budget' using errcode = '42501';
  end if;
  if p_period is null or p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid budget period' using errcode = '22023';
  end if;
  return query select * from private.ai_budget_status(p_period);
end
$$;

revoke all on function public.ai_budget_status(text) from public, anon;
grant execute on function public.ai_budget_status(text) to authenticated, service_role;
