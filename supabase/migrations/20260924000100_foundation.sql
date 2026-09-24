-- Foundation: owner identity, shared helpers and owner settings.
--
-- Security model (single private owner):
--   * Exactly one dashboard owner, stored in private.owner. Every owner table is
--     protected by the policy `public.is_owner()`, so a second Supabase auth user
--     (for example someone who completes Google sign-in with another address)
--     can read and write nothing.
--   * The `private` schema is never exposed to anon/authenticated. Secrets
--     (tokens, capture token hashes) live there and are touched only by server code.
--   * Supabase grants broad default privileges on `public`; every table created by
--     later migrations must call private.secure_owner_table(...) which enables RLS,
--     revokes anon/public access and installs the owner policy.

create schema if not exists private;
revoke all on schema private from public;
do $$
begin
  execute 'revoke all on schema private from anon, authenticated';
  execute 'grant usage on schema private to service_role';
end $$;

-- ---------------------------------------------------------------------------
-- Owner identity
-- ---------------------------------------------------------------------------

create table private.owner (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  email text not null,
  claimed_at timestamptz not null default now()
);

comment on table private.owner is
  'The single dashboard owner. Claimed by the server auth callback after it verifies the Google identity matches OWNER_EMAIL.';

create function public.is_owner() returns boolean
language sql stable security definer
set search_path = ''
as $$
  -- auth.jwt() ->> 'sub' is Supabase's current recommendation (auth.uid() is deprecated).
  select exists (
    select 1 from private.owner o
    where o.user_id = nullif((select auth.jwt()) ->> 'sub', '')::uuid
  )
$$;

revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;

-- Returns 'claimed' | 'already_owner' | 'rejected'. Server-only.
create function private.claim_owner(p_user_id uuid, p_email text) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  existing uuid;
begin
  if p_user_id is null or coalesce(trim(p_email), '') = '' then
    raise exception 'claim_owner requires a user id and email';
  end if;

  -- Serialise concurrent first sign-ins.
  lock table private.owner in share row exclusive mode;

  select o.user_id into existing from private.owner o;

  if existing is null then
    insert into private.owner (user_id, email) values (p_user_id, lower(trim(p_email)));
    return 'claimed';
  elsif existing = p_user_id then
    return 'already_owner';
  else
    return 'rejected';
  end if;
end
$$;

revoke all on function private.claim_owner(uuid, text) from public;
do $$ begin execute 'revoke all on function private.claim_owner(uuid, text) from anon, authenticated'; end $$;

-- ---------------------------------------------------------------------------
-- Helpers used by every later migration
-- ---------------------------------------------------------------------------

create function private.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Lock a public table down to the owner: RLS on, anon/public revoked, owner policy,
-- updated_at trigger when the column exists. Idempotent.
create function private.secure_owner_table(p_table regclass) returns void
language plpgsql
set search_path = ''
as $$
declare
  has_updated_at boolean;
  rel_name text;
begin
  select c.relname into rel_name from pg_class c where c.oid = p_table;

  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from public', p_table);
  execute format('revoke all on %s from anon', p_table);
  execute format('revoke all on %s from authenticated', p_table);
  execute format('grant select, insert, update, delete on %s to authenticated', p_table);
  execute format('grant all on %s to service_role', p_table);
  execute format('drop policy if exists owner_all on %s', p_table);
  execute format(
    'create policy owner_all on %s as permissive for all to authenticated '
    'using ((select public.is_owner())) with check ((select public.is_owner()))',
    p_table
  );

  select exists (
    select 1 from pg_attribute a
    where a.attrelid = p_table and a.attname = 'updated_at' and not a.attisdropped
  ) into has_updated_at;

  if has_updated_at then
    execute format('drop trigger if exists touch_updated_at on %s', p_table);
    execute format(
      'create trigger touch_updated_at before update on %s '
      'for each row execute function private.touch_updated_at()',
      p_table
    );
  end if;
end
$$;

revoke all on function private.secure_owner_table(regclass) from public;

create function private.is_valid_timezone(p_tz text) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz)
$$;

-- ---------------------------------------------------------------------------
-- Owner settings (singleton)
-- ---------------------------------------------------------------------------

create table public.owner_settings (
  singleton boolean primary key default true check (singleton),
  -- IANA timezone. Defaulted from the device during setup, shown for
  -- confirmation, then kept stable until the owner explicitly changes it.
  timezone text not null default 'Europe/London',
  timezone_confirmed boolean not null default false,
  display_name text check (display_name is null or length(display_name) <= 80),
  -- Optional availability: [{ "weekday": 1-7 (ISO, Monday=1), "start": "09:00", "end": "17:30" }]
  available_hours jsonb check (available_hours is null or jsonb_typeof(available_hours) = 'array'),
  -- [{ "module": "needs_attention", "hidden": false }] in display order
  home_layout jsonb not null default '[]'::jsonb check (jsonb_typeof(home_layout) = 'array'),
  notification_prefs jsonb not null default '{}'::jsonb check (jsonb_typeof(notification_prefs) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function private.validate_owner_settings() returns trigger
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

create trigger validate_owner_settings
before insert or update on public.owner_settings
for each row execute function private.validate_owner_settings();

select private.secure_owner_table('public.owner_settings');

insert into public.owner_settings (singleton) values (true) on conflict do nothing;
