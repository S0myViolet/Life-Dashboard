-- Shell: auth hardening for the single-owner dashboard.
--
-- A Supabase "Before User Created" auth hook (Postgres function) that only lets
-- allowlisted Google identities create an auth.users row. Strangers who finish
-- Google sign-in are rejected by Supabase Auth before any user row exists, so the
-- app never has to clean them up.
--
-- Contract (Supabase docs, auth-hooks / before-user-created-hook):
--   input  event jsonb = { metadata: {...}, user: { email, app_metadata: { provider }, is_anonymous, ... } }
--   allow  → return '{}'::jsonb
--   reject → return { "error": { "http_code": 403, "message": "..." } }
--   The function is invoked by the role supabase_auth_admin.
--
-- The owner enables it in the Supabase dashboard (Authentication → Hooks →
-- Before User Created → Postgres → public.hook_before_user_created) or in
-- supabase/config.toml ([auth.hook.before_user_created], uri =
-- "pg-functions://postgres/public/hook_before_user_created"), after inserting
-- their Google address into private.owner_allowlist. With an empty allowlist the
-- hook rejects everyone (fail closed).

create table private.owner_allowlist (
  email text primary key
    check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  created_at timestamptz not null default now()
);

comment on table private.owner_allowlist is
  'Email addresses (lower-case) allowed to create a Supabase Auth user via Google sign-in. Read by public.hook_before_user_created.';

revoke all on private.owner_allowlist from public;
do $$
begin
  execute 'revoke all on private.owner_allowlist from anon, authenticated';
end $$;

create function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user jsonb := case when jsonb_typeof(event -> 'user') = 'object' then event -> 'user' end;
  v_email text;
  v_provider text;
  v_anonymous boolean;
  v_reject constant jsonb := jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'This is a private dashboard. Sign-up is not available for this account.'
    )
  );
begin
  if v_user is null then
    return v_reject;
  end if;

  v_email := case when jsonb_typeof(v_user -> 'email') = 'string'
                  then lower(btrim(v_user ->> 'email')) end;
  v_provider := case when jsonb_typeof(v_user -> 'app_metadata' -> 'provider') = 'string'
                     then v_user -> 'app_metadata' ->> 'provider' end;
  v_anonymous := coalesce(v_user -> 'is_anonymous' = 'true'::jsonb, false);

  if v_anonymous
     or coalesce(v_email, '') = ''
     or v_provider is distinct from 'google'
     or not exists (select 1 from private.owner_allowlist a where a.email = v_email) then
    return v_reject;
  end if;

  return '{}'::jsonb;
end
$$;

comment on function public.hook_before_user_created(jsonb) is
  'Supabase Before User Created hook: allow only allowlisted Google sign-ups. Executable by supabase_auth_admin only.';

revoke all on function public.hook_before_user_created(jsonb) from public;
do $$
begin
  execute 'revoke all on function public.hook_before_user_created(jsonb) from anon, authenticated, service_role';
  -- supabase_auth_admin exists on hosted Supabase and the Supabase CLI stack, not in the local test shim.
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin';
  end if;
end $$;
