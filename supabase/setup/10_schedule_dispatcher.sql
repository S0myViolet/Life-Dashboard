-- Personal Home: schedule the minute job dispatcher (ONE-TIME OWNER SETUP).
--
-- This is not a migration. It configures the hosted project so that pg_cron
-- calls the `dispatcher` Edge Function every minute through pg_net, sending
-- the dispatcher secret from Supabase Vault (brief §6/§7; pattern from
-- https://supabase.com/docs/guides/functions/schedule-functions, with our own
-- secret header instead of a publishable key, which cannot authenticate a caller).
--
-- Before running:
--   1. Apply the migrations and deploy the function:
--        supabase db push
--        supabase functions deploy dispatcher
--   2. Generate a secret (at least 32 characters):  openssl rand -base64 32
--   3. Store it as an Edge Function secret:
--        supabase secrets set DISPATCHER_SECRET=<the value>
--   4. Dashboard → Database → Extensions: enable pg_cron and pg_net
--      (the two statements below do the same if you have the privileges).
--
-- Then paste this file into the Dashboard SQL editor, replace the two values in
-- the marked block (keep the quotes) and run it. Do not save or commit the
-- edited copy. Re-running is safe: the Vault secrets are updated in place and
-- the cron jobs are replaced (cron.schedule updates a job with the same name).
--
-- Rotating the secret: `supabase secrets set DISPATCHER_SECRET=<new>`, then
-- re-run this file with the new value. Calls in between get 401 and are simply
-- retried by the next minute's run.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $setup$
declare
  -- ▼▼▼ Fill in these two values ▼▼▼
  v_project_url text := 'https://YOUR-PROJECT-REF.supabase.co';
  v_dispatcher_secret text := 'PASTE-THE-DISPATCHER_SECRET-VALUE-HERE';
  -- ▲▲▲ (no trailing slash on the URL) ▲▲▲
  v_id uuid;
begin
  -- Error messages never echo the values.
  if v_project_url like '%YOUR-PROJECT-REF%'
     or v_project_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' then
    raise exception 'Set v_project_url to the project URL, e.g. https://abcdefghijkl.supabase.co (https, no path, no trailing slash)';
  end if;
  if v_dispatcher_secret like 'PASTE-THE-%'
     or length(v_dispatcher_secret) < 32
     or v_dispatcher_secret ~ '[[:space:]]' then
    raise exception 'Set v_dispatcher_secret to the DISPATCHER_SECRET function secret (at least 32 characters, no spaces)';
  end if;

  -- Vault: create or update the two named secrets.
  select s.id into v_id from vault.secrets s where s.name = 'ph_project_url';
  if v_id is null then
    perform vault.create_secret(v_project_url, 'ph_project_url',
      'Personal Home: project URL used by the ph-dispatcher cron job');
  else
    perform vault.update_secret(v_id, v_project_url, 'ph_project_url',
      'Personal Home: project URL used by the ph-dispatcher cron job');
  end if;

  v_id := null;
  select s.id into v_id from vault.secrets s where s.name = 'ph_dispatcher_secret';
  if v_id is null then
    perform vault.create_secret(v_dispatcher_secret, 'ph_dispatcher_secret',
      'Personal Home: x-dispatcher-secret header for the dispatcher Edge Function');
  else
    perform vault.update_secret(v_id, v_dispatcher_secret, 'ph_dispatcher_secret',
      'Personal Home: x-dispatcher-secret header for the dispatcher Edge Function');
  end if;

  -- Every minute: POST to the dispatcher. The command reads the secrets from
  -- Vault when it runs, so cron.job never contains them. The function's time
  -- budget is 40 s (supabase/functions/_shared/dispatcher-http.ts), so pg_net
  -- waits up to 55 s for its JSON summary (default would be 2 s).
  perform cron.schedule(
    'ph-dispatcher',
    '* * * * *',
    $cmd$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ph_project_url')
        || '/functions/v1/dispatcher',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-dispatcher-secret',
        (select decrypted_secret from vault.decrypted_secrets where name = 'ph_dispatcher_secret')
      ),
      body := jsonb_build_object('source', 'pg_cron'),
      timeout_milliseconds := 55000
    ) as request_id;
    $cmd$
  );

  -- cron.job_run_details grows without bound (1,440 rows a day from the job
  -- above); keep a week of history.
  perform cron.schedule(
    'ph-cron-history-cleanup',
    '17 3 * * *',
    $cmd$
    delete from cron.job_run_details where end_time < now() - interval '7 days';
    $cmd$
  );
end
$setup$;

-- Check it (run separately):
--   select jobid, jobname, schedule, active from cron.job where jobname like 'ph-%';
--   select status, return_message, start_time
--     from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'ph-dispatcher')
--     order by start_time desc limit 10;
--   -- pg_net keeps responses for 6 hours. Expect status_code 200 and a JSON summary;
--   -- 401 means the Vault secret and the DISPATCHER_SECRET function secret differ,
--   -- 503 means DISPATCHER_SECRET is missing or shorter than 32 characters.
--   select id, status_code, timed_out, error_msg, created
--     from net._http_response order by created desc limit 10;
--
-- Undo:
--   select cron.unschedule('ph-dispatcher');
--   select cron.unschedule('ph-cron-history-cleanup');
--   delete from vault.secrets where name in ('ph_project_url', 'ph_dispatcher_secret');
