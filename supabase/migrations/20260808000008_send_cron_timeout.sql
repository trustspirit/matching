-- H1 fix: ...0007 registered send-pending-codes without pg_net's
-- timeout_milliseconds, so net.http_post aborted the request at pg_net's own
-- DEFAULT of 5000ms while send-codes is designed to run up to TIME_BUDGET_MS
-- (120s). Worse, pg_net records that abort as a "success" in
-- net._http_response, so cron.job_run_details -- the table DEPLOY.txt tells
-- the operator to check -- kept reporting success the whole time. 350 people
-- would trickle out over hours with no visible cause.
--
-- ...0007 already ran locally and in production, so correcting that file
-- alone would not re-register the job: Supabase migrations never re-run once
-- applied. cron.schedule() re-registers a job in place when called again with
-- the same jobname, which is what this migration does. ...0007 itself is also
-- corrected in the same commit so a fresh `db reset` produces the right job
-- from the start; this migration exists only to carry that fix to a database
-- where ...0007 already ran.
select cron.schedule(
  'send-pending-codes',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url     := s.url,
      headers := jsonb_build_object(
        'Content-Type',   'application/json',
        'x-cron-secret',  s.secret
      ),
      body    := jsonb_build_object('action', 'run'),
      -- pg_net's own default is 5000ms. Left unset, net.http_post would abort
      -- the request at 5 seconds while send-codes is designed to run up to
      -- TIME_BUDGET_MS (120s) -- and pg_net still records that abort as a
      -- "success" in net._http_response, so cron.job_run_details (the table
      -- DEPLOY.txt tells the operator to check) would keep reporting success
      -- while 350 people trickle out over hours with no visible cause.
      -- 150000 matches the platform's own Edge Function kill ceiling,
      -- comfortably above the 120s budget.
      timeout_milliseconds := 150000
    )
    from (
      select
        (select value from public.app_config where key = 'send_codes_url')    as url,
        (select value from public.app_config where key = 'cron_secret')       as secret,
        (select value from public.app_config where key = 'code_send_armed')   as armed,
        (select value from public.app_config where key = 'send_retry_after')  as retry_after
    ) s
    -- send_codes_url is written by the function on the first authenticated
    -- admin request. Before that there is nothing to call, and locally there
    -- never will be, so the job has to no-op instead of erroring every slot.
    where s.url is not null
      and s.secret is not null
      -- Disarmed is the resting state: sending disarms itself once the queue
      -- empties, so this is what stops the schedule from doing anything at all
      -- between events.
      and s.armed = 'true'
      -- After the daily allowance is gone, send-codes asks Brevo's own
      -- GET /v3/account for the account's timezone and books the retry for
      -- its next midnight; an unexpected 402 that slips past that probe
      -- falls back to a one-hour backoff instead (see QUOTA_BACKOFF_MS in
      -- send-codes/index.ts). Either way this keeps the schedule from
      -- re-probing every five minutes while the allowance is empty; the
      -- function sets this timestamp.
      --
      -- app_config.value is NOT NULL, so "no backoff" is stored as the empty
      -- string. nullif is what keeps that from reaching ::timestamptz, which
      -- would raise and abort the whole job every five minutes.
      and (nullif(s.retry_after, '') is null
           or now() >= nullif(s.retry_after, '')::timestamptz);
  $job$
);
