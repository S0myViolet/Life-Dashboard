-- Milestone 1 schema: the personal tools that work with nothing connected.
-- Tasks, habits, reminders, notes, journal (incl. voice recordings), reading, learning goals, people.
--
-- Shared contract for the Milestone 1 builders. Owner-only via private.secure_owner_table().
-- Links to public.projects (created by the capture migration) are added as foreign keys in a
-- later migration once both branches are merged; until then project_id is a plain uuid.

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 300),
  details text check (details is null or length(details) <= 10000),
  project_id uuid,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  -- 1 = highest. Null = no explicit priority.
  priority smallint check (priority between 1 and 4),
  -- A local calendar date (owner timezone). When due_at is set, due_date is its local date.
  due_date date,
  -- An explicit deadline instant, when the owner gave a time.
  due_at timestamptz,
  -- Owner-entered effort. Null means "not given"; the planner labels its own estimate.
  duration_minutes integer check (duration_minutes between 5 and 720),
  splittable boolean not null default false,
  -- Where the task came from. Inferred items stay unconfirmed until the owner accepts them.
  source text not null default 'manual'
    check (source in ('manual', 'quick_capture', 'plan', 'project_action', 'email_suggestion', 'chat_suggestion')),
  confirmed boolean not null default true,
  -- Provenance for inferred items (e.g. { "kind": "email", "id": "...", "url": "..." }).
  source_ref jsonb check (source_ref is null or jsonb_typeof(source_ref) = 'object'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_due_at_has_date check (due_at is null or due_date is not null),
  constraint tasks_done_has_time check ((status = 'done') = (completed_at is not null))
);

create index tasks_open_due_idx on public.tasks (status, due_date, due_at);
create index tasks_project_idx on public.tasks (project_id) where project_id is not null;

select private.secure_owner_table('public.tasks');

-- ---------------------------------------------------------------------------
-- Habits
-- ---------------------------------------------------------------------------

create table public.habits (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 200),
  details text check (details is null or length(details) <= 2000),
  -- ISO weekdays the habit is due on (1 = Monday ... 7 = Sunday).
  weekdays smallint[] not null default '{1,2,3,4,5,6,7}'
    check (cardinality(weekdays) between 1 and 7 and weekdays <@ '{1,2,3,4,5,6,7}'::smallint[]),
  active boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

select private.secure_owner_table('public.habits');

create table public.habit_completions (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references public.habits (id) on delete cascade,
  local_date date not null,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (habit_id, local_date)
);

select private.secure_owner_table('public.habit_completions');

-- ---------------------------------------------------------------------------
-- Reminders (owner-created; in-app in M1, Web Push delivery arrives in M2)
-- ---------------------------------------------------------------------------

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 300),
  subject_kind text not null default 'custom' check (subject_kind in ('custom', 'task', 'person', 'habit')),
  subject_id uuid,
  remind_at timestamptz not null,
  recurrence text check (recurrence in ('daily', 'weekly', 'monthly', 'yearly')),
  status text not null default 'scheduled' check (status in ('scheduled', 'delivered', 'dismissed', 'cancelled')),
  delivered_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reminders_subject check ((subject_kind = 'custom') = (subject_id is null))
);

create index reminders_due_idx on public.reminders (status, remind_at);

select private.secure_owner_table('public.reminders');

-- ---------------------------------------------------------------------------
-- Notes (freeform, searchable, optimistic concurrency for offline edits)
-- ---------------------------------------------------------------------------

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  title text check (title is null or length(title) <= 300),
  body text not null default '' check (length(body) <= 200000),
  pinned boolean not null default false,
  project_id uuid,
  linked_date date,
  book_id uuid,
  person_id uuid,
  -- Incremented on every saved edit; writers send the version they edited.
  version integer not null default 1 check (version >= 1),
  search tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', body), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notes_search_idx on public.notes using gin (search);
create index notes_recent_idx on public.notes (pinned desc, updated_at desc);

select private.secure_owner_table('public.notes');

-- ---------------------------------------------------------------------------
-- Journal (typed or recorded; no mood fields by design)
-- ---------------------------------------------------------------------------

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  local_date date not null,
  body text not null default '' check (length(body) <= 200000),
  -- Optional prompt answers: { "what_happened", "moved_forward", "needs_attention", "next" }.
  prompts jsonb not null default '{}'::jsonb check (jsonb_typeof(prompts) = 'object'),
  origin text not null default 'typed' check (origin in ('typed', 'voice')),
  transcript_status text
    check (transcript_status in ('pending', 'transcribing', 'ready_for_review', 'saved', 'failed', 'unavailable')),
  version integer not null default 1 check (version >= 1),
  search tsvector generated always as (to_tsvector('simple', body)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index journal_entries_date_idx on public.journal_entries (local_date desc);
create index journal_entries_search_idx on public.journal_entries using gin (search);

select private.secure_owner_table('public.journal_entries');

-- Voice recordings are stored in Postgres (chunked) rather than Supabase Storage: chunked uploads
-- stay under serverless request limits, the data is owner-scoped by RLS like everything else, and
-- it is included in database backups. Recordings are deleted once a transcript is saved; failed ones
-- expire after seven days (see docs/DECISIONS.md).
create table public.journal_recordings (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.journal_entries (id) on delete cascade,
  mime_type text not null check (mime_type ~ '^audio/[a-z0-9.+-]+(;.*)?$'),
  byte_size integer not null default 0 check (byte_size between 0 and 26214400),
  duration_seconds numeric(8, 2) check (duration_seconds is null or duration_seconds between 0 and 3600),
  expected_chunks integer check (expected_chunks is null or expected_chunks between 1 and 64),
  status text not null default 'uploading'
    check (status in ('uploading', 'uploaded', 'transcribing', 'transcribed', 'failed')),
  failure_reason text check (failure_reason is null or length(failure_reason) <= 500),
  attempts integer not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index journal_recordings_expiry_idx on public.journal_recordings (expires_at) where expires_at is not null;

select private.secure_owner_table('public.journal_recordings');

create table public.journal_recording_chunks (
  recording_id uuid not null references public.journal_recordings (id) on delete cascade,
  seq integer not null check (seq between 0 and 63),
  data bytea not null check (octet_length(data) between 1 and 1048576),
  created_at timestamptz not null default now(),
  primary key (recording_id, seq)
);

select private.secure_owner_table('public.journal_recording_chunks');

-- ---------------------------------------------------------------------------
-- Reading and learning
-- ---------------------------------------------------------------------------

create table public.books (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 300),
  author text check (author is null or length(author) <= 200),
  total_pages integer check (total_pages between 1 and 20000),
  status text not null default 'want' check (status in ('want', 'reading', 'paused', 'finished')),
  started_on date,
  finished_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

select private.secure_owner_table('public.books');

-- Any one measure is enough: pages read in the session, page reached, or a percentage.
create table public.reading_logs (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books (id) on delete cascade,
  local_date date not null,
  pages_read integer check (pages_read between 1 and 5000),
  page_reached integer check (page_reached between 0 and 20000),
  percent numeric(5, 2) check (percent between 0 and 100),
  minutes integer check (minutes between 1 and 1440),
  note text check (note is null or length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reading_logs_has_measure
    check (pages_read is not null or page_reached is not null or percent is not null or minutes is not null)
);

create index reading_logs_book_idx on public.reading_logs (book_id, local_date desc);

select private.secure_owner_table('public.reading_logs');

create table public.learning_goals (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 200),
  details text check (details is null or length(details) <= 4000),
  target_date date,
  status text not null default 'active' check (status in ('active', 'paused', 'done')),
  habit_id uuid references public.habits (id) on delete set null,
  book_id uuid references public.books (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

select private.secure_owner_table('public.learning_goals');

-- ---------------------------------------------------------------------------
-- People (manual only: no contact import, no relationship scoring)
-- ---------------------------------------------------------------------------

create table public.people (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  relationship text check (relationship is null or length(relationship) <= 100),
  notes text check (notes is null or length(notes) <= 20000),
  catch_up_every_days integer check (catch_up_every_days between 7 and 730),
  last_caught_up_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

select private.secure_owner_table('public.people');

create table public.person_dates (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people (id) on delete cascade,
  label text not null check (length(btrim(label)) between 1 and 80),
  month smallint not null check (month between 1 and 12),
  day smallint not null check (day between 1 and 31),
  year smallint check (year between 1900 and 2200),
  remind_days_before integer not null default 7 check (remind_days_before between 0 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint person_dates_valid_day check (
    (month in (4, 6, 9, 11) and day <= 30) or (month = 2 and day <= 29) or (month not in (2, 4, 6, 9, 11))
  )
);

select private.secure_owner_table('public.person_dates');

-- Link notes to books and people now that both tables exist.
alter table public.notes
  add constraint notes_book_fk foreign key (book_id) references public.books (id) on delete set null,
  add constraint notes_person_fk foreign key (person_id) references public.people (id) on delete set null;
