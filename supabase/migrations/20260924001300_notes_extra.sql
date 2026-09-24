-- Notes and journal additions (notes-journal area, Milestone 1).
--
-- Builds on 20260924001000_m1_schema.sql. No new tables: every column added here lives on a
-- table already secured with private.secure_owner_table(), so RLS and the owner policy apply.

-- ---------------------------------------------------------------------------
-- Journal entries: one page per owner-local date
-- ---------------------------------------------------------------------------

-- "Entries per local date": typing, recordings and prompts for a day all land on one entry, so
-- two devices (or an offline draft and a recording) can never create competing entries for the
-- same day. Writers use insert ... on conflict (local_date).
create unique index journal_entries_local_date_key on public.journal_entries (local_date);

-- Machine transcript(s) waiting for the owner's review. This is never the final text: the owner
-- edits it and saves it into `body` (or discards it). Kept on the entry, not on the recording, so
-- purging an expired recording can never lose a transcript that has not been reviewed yet.
alter table public.journal_entries
  add column transcript_draft text
    check (transcript_draft is null or length(transcript_draft) <= 200000);

-- ---------------------------------------------------------------------------
-- Journal recordings: resumable chunked upload, transcription lease, bounded retention
-- ---------------------------------------------------------------------------

alter table public.journal_recordings
  -- Every chunk except the last is exactly this many bytes, so a resumed upload slices the same
  -- blob identically and a repeated chunk write can be compared byte for byte.
  add column chunk_bytes integer not null default 1000000
    check (chunk_bytes between 65536 and 1048576),
  add column uploaded_at timestamptz,
  -- Set while a transcription attempt holds the recording; a stale value (worker died) lets a
  -- retry take over. `attempts` is the fencing token for finishing an attempt.
  add column transcribing_since timestamptz,
  add column last_attempt_at timestamptz,
  add constraint journal_recordings_transcribing_since
    check ((status = 'transcribing') = (transcribing_since is not null)),
  add constraint journal_recordings_uploaded_at
    check (status = 'uploading' or uploaded_at is not null);

-- Retention (brief §7): a recording is deleted once its transcript is saved; otherwise it is kept
-- for at most seven days. The expiry is fixed when the recording is created and can never be
-- pushed later than seven days after that, whatever code path writes the row.
alter table public.journal_recordings
  alter column expires_at set default (now() + interval '7 days'),
  alter column expires_at set not null,
  add constraint journal_recordings_expiry_within_retention
    check (expires_at <= created_at + interval '7 days');

create index journal_recordings_entry_idx on public.journal_recordings (entry_id, created_at);

-- ---------------------------------------------------------------------------
-- Notes: "notes for this date" lookups
-- ---------------------------------------------------------------------------

create index notes_linked_date_idx on public.notes (linked_date) where linked_date is not null;
