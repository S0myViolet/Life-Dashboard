-- Connections: one row per connected provider account, its encrypted tokens,
-- one-time OAuth states, and incremental sync cursors (used from Milestone 2).
--
-- Security model:
--   * public.connections, public.sync_cursors and public.connection_events are
--     owner-READABLE only. Every change (connect, pause/resume, rename,
--     disconnect, job outcomes) goes through server code (Next.js server
--     actions/route handlers after requireOwner(), or background jobs) using the
--     service connection. This is a stricter variant of
--     private.secure_owner_table(): RLS stays on with the owner policy, anon has
--     nothing, and `authenticated` keeps SELECT only, so a browser holding the
--     owner's Supabase JWT cannot mark a connection healthy or rewrite cursors.
--   * Tokens and OAuth PKCE verifiers live in `private` (no anon/authenticated
--     usage) and are AES-256-GCM envelopes bound to their row
--     (context `connection:<id>:refresh_token` etc.), never plaintext.
--   * Integration consent is separate from app sign-in: nothing here touches
--     auth.users or private.owner.

-- ---------------------------------------------------------------------------
-- Connected accounts
-- ---------------------------------------------------------------------------

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (
    provider in ('google', 'microsoft', 'chatgpt', 'claude', 'lunchflow', 'whoop', 'spotify', 'football_data', 'rss')
  ),
  -- Display label, normally the mailbox address. Editable by the owner.
  account_label text not null check (length(account_label) between 1 and 200),
  -- Stable provider identity (Google `sub`, Microsoft Graph user id).
  external_account_id text not null check (length(external_account_id) between 1 and 255),
  -- Only statuses that describe an existing account; needs_setup / not_connected /
  -- unsupported describe providers without a row and are computed by the app.
  status text not null default 'connected' check (
    status in ('connected', 'syncing', 'paused', 'needs_reconnect', 'error')
  ),
  -- Normalised scopes the provider actually granted (granular consent can grant fewer).
  granted_scopes text[] not null default '{}' check (cardinality(granted_scopes) <= 64),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  -- `<kind>.<detail>`, e.g. auth.invalid_grant, rate_limited.http_429.
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  -- Sanitised by the app (no tokens, codes, emails or URL queries).
  last_error_message text check (last_error_message is null or length(last_error_message) <= 500),
  next_attempt_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  paused_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_account_id),
  -- Paused exactly when paused_at is set: only the owner pauses and resumes.
  constraint connections_paused_consistent check ((status = 'paused') = (paused_at is not null))
);

comment on table public.connections is
  'One row per connected provider account. Owner can read; all writes go through server code.';

select private.secure_owner_table('public.connections');
revoke insert, update, delete on public.connections from authenticated;

create index connections_due_idx on public.connections (provider, next_attempt_at)
  where paused_at is null and status <> 'needs_reconnect';

-- ---------------------------------------------------------------------------
-- Encrypted tokens (server only)
-- ---------------------------------------------------------------------------

create table private.connection_tokens (
  connection_id uuid primary key references public.connections (id) on delete cascade,
  refresh_token_ciphertext text not null check (refresh_token_ciphertext ~ '^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  access_token_ciphertext text check (
    access_token_ciphertext is null or access_token_ciphertext ~ '^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  ),
  access_token_expires_at timestamptz,
  key_version integer not null check (key_version >= 1),
  updated_at timestamptz not null default now()
);

comment on table private.connection_tokens is
  'AES-256-GCM envelopes of provider tokens, bound to connection id. Never readable by anon/authenticated.';

revoke all on private.connection_tokens from public;
do $$
begin
  execute 'revoke all on private.connection_tokens from anon, authenticated';
  execute 'grant select, insert, update, delete on private.connection_tokens to service_role';
end $$;

create trigger touch_updated_at before update on private.connection_tokens
for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- One-time OAuth states (server only)
-- ---------------------------------------------------------------------------

create table private.oauth_states (
  -- SHA-256 (hex) of the state value; the value itself only travels in the redirect.
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider in ('google', 'microsoft', 'whoop', 'spotify')),
  -- PKCE verifier, encrypted with context `oauth_state:<state_hash>:code_verifier`.
  code_verifier_ciphertext text not null check (code_verifier_ciphertext ~ '^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  -- Same-origin path to return to after the callback (no '//', no query, no scheme).
  return_to text not null check (return_to ~ '^/([A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*)?$' and length(return_to) <= 200),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  consumed_at timestamptz,
  constraint oauth_states_ttl check (expires_at > created_at and expires_at <= created_at + interval '10 minutes')
);

create index oauth_states_expires_idx on private.oauth_states (expires_at);

revoke all on private.oauth_states from public;
do $$
begin
  execute 'revoke all on private.oauth_states from anon, authenticated';
  execute 'grant select, insert, update, delete on private.oauth_states to service_role';
end $$;

-- ---------------------------------------------------------------------------
-- Incremental sync cursors (Milestone 2): Gmail historyId, Google Calendar
-- syncToken, Microsoft delta links, per account / folder / calendar.
-- ---------------------------------------------------------------------------

create table public.sync_cursors (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections (id) on delete cascade,
  -- e.g. gmail.history, gcal.events, gcal.calendar_list, graph.messages, graph.calendar_view
  resource_type text not null check (resource_type ~ '^[a-z][a-z0-9_.]{0,63}$'),
  -- Folder / calendar id; '' when the cursor covers the whole account.
  resource_id text not null default '' check (length(resource_id) <= 512),
  cursor text check (cursor is null or length(cursor) <= 8192),
  window_start timestamptz,
  window_end timestamptz,
  status text not null default 'pending' check (
    status in ('pending', 'initial_sync', 'partial', 'synced', 'needs_resync', 'error')
  ),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, resource_type, resource_id),
  check (window_start is null or window_end is null or window_start < window_end)
);

select private.secure_owner_table('public.sync_cursors');
revoke insert, update, delete on public.sync_cursors from authenticated;

-- ---------------------------------------------------------------------------
-- Connection history: connects, pauses, disconnects and whether revocation at
-- the provider worked (so a failed revoke stays visible after the row is gone).
-- ---------------------------------------------------------------------------

create table public.connection_events (
  id uuid primary key default gen_random_uuid(),
  -- No foreign key: the connection row is deleted on disconnect.
  connection_id uuid not null,
  provider text not null check (
    provider in ('google', 'microsoft', 'chatgpt', 'claude', 'lunchflow', 'whoop', 'spotify', 'football_data', 'rss')
  ),
  account_label text not null check (length(account_label) between 1 and 200),
  kind text not null check (kind in ('connected', 'reconnected', 'paused', 'resumed', 'renamed', 'disconnected')),
  revoke_outcome text check (
    revoke_outcome is null or revoke_outcome in ('revoked', 'already_invalid', 'not_supported', 'failed')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'disconnected') = (revoke_outcome is not null))
);

create index connection_events_recent_idx on public.connection_events (created_at desc);

select private.secure_owner_table('public.connection_events');
revoke insert, update, delete on public.connection_events from authenticated;
