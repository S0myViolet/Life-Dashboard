-- Learning and people: columns and checks on top of the Milestone 1 schema
-- (20260924001000_m1_schema.sql). No new tables, so no new secure_owner_table() calls:
-- every table touched here is already owner-only.

-- ---------------------------------------------------------------------------
-- Reading and learning
-- ---------------------------------------------------------------------------

-- A book cannot be finished before it was started.
alter table public.books
  add constraint books_finished_after_started
    check (finished_on is null or started_on is null or finished_on >= started_on);

create index books_status_idx on public.books (status, updated_at desc);

-- "30 min/day" reading goals: measured against the minutes in reading logs.
alter table public.learning_goals
  add column daily_minutes integer check (daily_minutes between 5 and 600);

-- Foreign keys declared with `on delete set null` scan these columns on delete.
create index learning_goals_habit_idx on public.learning_goals (habit_id) where habit_id is not null;
create index learning_goals_book_idx on public.learning_goals (book_id) where book_id is not null;

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

-- The day a catch-up cadence was set. Until the first catch-up is recorded, the next one
-- is due one interval after this date (instead of immediately, or never).
alter table public.people
  add column catch_up_started_on date;

alter table public.people
  add constraint people_cadence_started
    check (catch_up_every_days is not null or catch_up_started_on is null);

create index people_name_idx on public.people (lower(name));

-- The base check allows 29 February for any year; with a year it must be a leap year.
alter table public.person_dates
  add constraint person_dates_leap_day_year check (
    year is null or month <> 2 or day <> 29
    or (year % 4 = 0 and (year % 100 <> 0 or year % 400 = 0))
  );

create index person_dates_person_idx on public.person_dates (person_id);
