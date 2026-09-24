-- Planner: one daily plan per local date and its blocks (Milestone 1).
--
-- A plan is drafted deterministically (packages/core/src/planner) on first use each local day,
-- then refined by the owner (accept, edit, reorder, pin, dismiss, done). Replans only ever
-- change the planner's own unaccepted suggestions. Accepting creates local plan blocks only:
-- nothing here writes to an external calendar.

-- Exclusion constraint on (plan_id =, time range &&) needs btree_gist for the uuid equality.
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Daily plans
-- ---------------------------------------------------------------------------

create table public.daily_plans (
  id uuid primary key default gen_random_uuid(),
  -- The owner-local date planned. Unique: concurrent first loads of a day create one plan.
  local_date date not null,
  -- IANA timezone the plan was drafted in (the owner's setting at the time).
  timezone text not null check (length(timezone) between 1 and 64),
  generated_at timestamptz not null default now(),
  source text not null check (source in ('auto_first_use', 'manual', 'briefing', 'replan')),
  -- 'time' when available hours were set (blocks have times), 'list' otherwise (no invented times).
  mode text not null check (mode in ('time', 'list')),
  -- Latest planner output (priorities with reasons, can wait, does not fit, capacity, notes).
  draft jsonb not null check (jsonb_typeof(draft) = 'object' and octet_length(draft::text) <= 1000000),
  -- 'draft' until the owner accepts, pins or completes a block; then 'active'.
  status text not null default 'draft' check (status in ('draft', 'active')),
  -- Incremented on every change to the plan or its blocks.
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_plans_local_date_key unique (local_date)
);

create function private.validate_daily_plan() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Inline lookup: triggers run as the invoking role, which has no usage on `private`.
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'invalid IANA timezone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end
$$;

revoke all on function private.validate_daily_plan() from public;

create trigger validate_daily_plan
before insert or update of timezone on public.daily_plans
for each row execute function private.validate_daily_plan();

select private.secure_owner_table('public.daily_plans');

-- ---------------------------------------------------------------------------
-- Plan blocks
-- ---------------------------------------------------------------------------

create table public.plan_blocks (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.daily_plans (id) on delete cascade,
  -- What the block is for. task / project_action / email_deadline reference public.tasks in M1,
  -- habit references public.habits, reading_goal references public.learning_goals.
  -- Not a foreign key: the block keeps its title snapshot if the source is deleted.
  candidate_kind text not null
    check (candidate_kind in ('task', 'project_action', 'email_deadline', 'habit', 'reading_goal')),
  candidate_id uuid not null,
  title_snapshot text not null check (length(btrim(title_snapshot)) between 1 and 300),
  -- scheduled = timed suggestion, small = small task placed in a short gap, list = list mode (no time).
  bucket text not null default 'scheduled' check (bucket in ('scheduled', 'small', 'list')),
  -- Null in list mode (no invented times).
  start_at timestamptz,
  end_at timestamptz,
  minutes integer not null check (minutes between 1 and 1440),
  position integer not null default 0 check (position >= 0),
  state text not null default 'suggested'
    check (state in ('suggested', 'accepted', 'pinned', 'dismissed', 'done')),
  -- True when the duration is the planner's labelled estimate rather than an entered duration.
  estimated boolean not null default false,
  -- True for unconfirmed inferences (e.g. email/project suggestions not yet accepted as tasks).
  tentative boolean not null default false,
  split_part smallint check (split_part between 1 and 99),
  split_total smallint check (split_total between 1 and 99),
  priority_rank smallint check (priority_rank between 1 and 3),
  note text check (note is null or length(note) <= 200),
  -- The owner changed this block's time, duration or order: a replan never touches it.
  edited_by_owner boolean not null default false,
  accepted_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plan_blocks_times check ((start_at is null) = (end_at is null)),
  constraint plan_blocks_span check (
    start_at is null
    or (end_at > start_at and minutes = round(extract(epoch from (end_at - start_at)) / 60))
  ),
  constraint plan_blocks_split check (
    (split_part is null) = (split_total is null) and (split_part is null or split_part <= split_total)
  ),
  constraint plan_blocks_done check ((state = 'done') = (done_at is not null)),
  -- Defence in depth for "no overlaps": two blocks of one plan that still occupy time can never
  -- overlap. Deferred so an owner's swap of two blocks can update both rows in one transaction.
  constraint plan_blocks_no_overlap exclude using gist (
    plan_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (start_at is not null and state <> 'dismissed') deferrable initially deferred
);

create index plan_blocks_plan_idx on public.plan_blocks (plan_id, position);
create index plan_blocks_candidate_idx on public.plan_blocks (candidate_kind, candidate_id);

select private.secure_owner_table('public.plan_blocks');
