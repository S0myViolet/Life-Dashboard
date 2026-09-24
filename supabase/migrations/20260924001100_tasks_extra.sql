-- Tasks area additions to the Milestone 1 schema (20260924001000_m1_schema.sql).
--
-- 1. Recurrence anchors for reminders.
--    A recurring reminder's next time is computed in owner-local calendar terms.
--    Deriving it only from the previous remind_at drifts for good after two
--    common cases: a monthly reminder on the 31st clamped to 30 April would stay
--    on the 30th, and a daily 01:30 reminder moved to 02:30 by the spring-forward
--    gap would stay at 02:30. Keeping the owner's chosen wall-clock time and day
--    of month avoids both. The columns are optional: other writers (the people
--    area, push delivery) may insert plain reminders, and readers then fall back
--    to remind_at's local time and day.
--
-- 2. Task reminders have no foreign key (subject_id is polymorphic), so deleting
--    a task deletes its reminders here, whichever code path deletes the task.

alter table public.reminders
  add column recurrence_time text
    check (recurrence_time is null or recurrence_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column recurrence_day smallint
    check (recurrence_day is null or recurrence_day between 1 and 31),
  add constraint reminders_anchors_need_recurrence
    check (recurrence is not null or (recurrence_time is null and recurrence_day is null));

comment on column public.reminders.recurrence_time is
  'Owner-local wall-clock time (HH:MM) a recurring reminder fires at; null = use remind_at''s local time.';
comment on column public.reminders.recurrence_day is
  'Day-of-month anchor for monthly/yearly reminders (clamped to short months); null = use remind_at''s local day.';

create index reminders_subject_idx on public.reminders (subject_kind, subject_id)
  where subject_id is not null;

-- Runs as the invoking role (the owner through RLS, or the service role).
create function private.tasks_delete_task_reminders() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.reminders r where r.subject_kind = 'task' and r.subject_id = old.id;
  return old;
end
$$;

revoke all on function private.tasks_delete_task_reminders() from public;

create trigger tasks_delete_task_reminders
after delete on public.tasks
for each row execute function private.tasks_delete_task_reminders();
