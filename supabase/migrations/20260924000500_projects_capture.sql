-- Projects and ChatGPT/Claude conversation capture (Chrome helper).
--
-- Owned by the capture area. Security model:
--   * public.* tables are owner-only through private.secure_owner_table(...).
--     The owner selects conversations and manages projects with RLS-enforced
--     transactions; capture ingestion runs as the trusted server role only after
--     the device token has been verified (hash lookup, not revoked, origin match).
--   * Device tokens and pairing codes live in `private` as SHA-256 hashes. Plain
--     values are shown exactly once (pairing code to the owner, token to the
--     extension) and never stored.
--   * Raw captured text lives only in captured_message_versions.text and is purged
--     after 30 days (see capturePurgeRawText); hashes and metadata stay so later
--     captures can still be reconciled without duplicating messages or summaries.
--   * Nothing here ever deletes captured messages because a page did not render
--     them: deletion happens only when the owner removes a conversation.

-- ---------------------------------------------------------------------------
-- Projects (minimal for M0; Milestone 2 adds notes, tasks, progress, questions)
-- ---------------------------------------------------------------------------

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  kind text not null check (kind in ('work', 'personal')),
  goal text check (goal is null or length(goal) <= 2000),
  status text not null default 'active' check (status in ('active', 'paused', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_status_idx on public.projects (status, created_at desc);

select private.secure_owner_table('public.projects');

-- ---------------------------------------------------------------------------
-- Selected conversations
-- ---------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('chatgpt', 'claude')),
  -- The UUID from the conversation URL (/c/<uuid> on chatgpt.com, /chat/<uuid> on claude.ai).
  external_id uuid not null,
  -- Canonical conversation URL: https, exact provider host, no query or fragment.
  url text not null check (
    length(url) <= 2048
    and (
      (provider = 'chatgpt' and url like 'https://chatgpt.com/%')
      or (provider = 'claude' and url like 'https://claude.ai/%')
    )
  ),
  title text check (title is null or length(title) <= 500),
  project_id uuid references public.projects (id) on delete set null,
  selected_at timestamptz not null default now(),
  capture_state text not null default 'active' check (
    capture_state in ('active', 'paused', 'needs_attention', 'signed_out', 'structure_changed')
  ),
  -- Why the state last changed: 'owner' | 'signed_out' | 'challenge' | 'structure_changed'.
  state_reason text check (state_reason is null or length(state_reason) <= 64),
  state_changed_at timestamptz,
  last_captured_at timestamptz,
  -- Latest capture whose page showed the first and the last message with nothing streaming.
  last_seen_complete_at timestamptz,
  -- Set when a snapshot added a message or changed a message's current text; M2 summaries
  -- are re-requested only when this moves.
  content_changed_at timestamptz,
  -- Stored messages. Never decreases because of a partial page.
  message_count integer not null default 0 check (message_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_id)
);

create index conversations_project_idx on public.conversations (project_id);
create index conversations_state_idx on public.conversations (capture_state);

select private.secure_owner_table('public.conversations');

-- ---------------------------------------------------------------------------
-- Captured messages and their text versions
-- ---------------------------------------------------------------------------

create table public.captured_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- Identity inside the conversation. Provider id when the page exposes one
  -- (ChatGPT data-message-id). Otherwise a derived key:
  --   'd:<row index>:<role>:<n>'  Claude rows ([data-index]); stable per thread position,
  --                               so an edited message becomes a new version of the same key.
  --   'h:<sha256 prefix>:<n>'     content-derived fallback when no id or position exists;
  --                               an edit then appears as a new message.
  message_key text not null check (length(message_key) between 1 and 200),
  key_source text not null check (key_source in ('provider', 'derived')),
  role text not null check (role in ('user', 'assistant')),
  -- Ordering only; never identity. Provider position hint from the latest observation
  -- that carried one (order_observed_at), or an interpolated value (order_observed_at null).
  order_hint double precision not null,
  order_observed_at timestamptz,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, message_key),
  check (first_seen_at <= last_seen_at)
);

create index captured_messages_order_idx
  on public.captured_messages (conversation_id, order_hint, first_seen_at, message_key);

create table public.captured_message_versions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.captured_messages (id) on delete cascade,
  -- sha256 hex of the normalized text. Kept after the text is purged.
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- Raw captured text; null once purged by retention.
  text text check (text is null or length(text) <= 200000),
  text_purged_at timestamptz,
  char_count integer not null check (char_count >= 0),
  -- Earliest and latest capture time at which this exact text was observed.
  captured_at timestamptz not null,
  last_observed_at timestamptz not null,
  -- When a different text of the same message was observed after this one (null = current).
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, content_hash),
  unique (message_id, id),
  check ((text is null) = (text_purged_at is not null)),
  check (captured_at <= last_observed_at)
);

create index captured_message_versions_retention_idx
  on public.captured_message_versions (captured_at)
  where text is not null;

-- The current version must belong to the same message.
alter table public.captured_messages
  add constraint captured_messages_current_version_fk
  foreign key (id, current_version_id)
  references public.captured_message_versions (message_id, id)
  on delete set null (current_version_id)
  deferrable initially deferred;

select private.secure_owner_table('public.captured_messages');
select private.secure_owner_table('public.captured_message_versions');

-- ---------------------------------------------------------------------------
-- Snapshot log (no message text; coverage and outcome only)
-- ---------------------------------------------------------------------------

create table public.capture_snapshots (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- Generated by the extension; a retried upload of the same snapshot is answered
  -- from this row instead of being applied twice.
  client_snapshot_id uuid not null,
  captured_at timestamptz not null,
  received_at timestamptz not null default now(),
  coverage jsonb not null check (jsonb_typeof(coverage) = 'object'),
  mode text not null check (mode in ('passive', 'revisit')),
  message_count integer not null check (message_count >= 0),
  outcome text not null check (outcome in ('applied', 'ignored_partial', 'rejected')),
  reason text check (reason is null or length(reason) <= 64),
  new_messages integer not null default 0 check (new_messages >= 0),
  new_versions integer not null default 0 check (new_versions >= 0),
  extension_version text check (extension_version is null or length(extension_version) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, client_snapshot_id)
);

create index capture_snapshots_conversation_idx
  on public.capture_snapshots (conversation_id, received_at desc);

select private.secure_owner_table('public.capture_snapshots');

-- ---------------------------------------------------------------------------
-- Paired Chrome helper devices and one-time pairing codes (server only)
-- ---------------------------------------------------------------------------

create table private.capture_devices (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 60),
  -- sha256 hex of the bearer token. The token itself is returned once at pairing.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Origin recorded from the pairing request; later requests must come from it.
  extension_origin text not null check (extension_origin ~ '^chrome-extension://[a-p]{32}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create table private.capture_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  -- sha256 hex of the normalized one-time code.
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  -- Failed redemption attempts while this code was live. At 5 the code is dead.
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  device_id uuid references private.capture_devices (id) on delete set null,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

revoke all on private.capture_devices, private.capture_pairing_codes from public;
do $$
begin
  execute 'revoke all on private.capture_devices, private.capture_pairing_codes from anon, authenticated';
  execute 'grant all on private.capture_devices, private.capture_pairing_codes to service_role';
end $$;
