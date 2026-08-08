-- A run that stops on the 120-second budget has to resume quickly: the admin is
-- usually watching. Five minutes is as slow as that may get.
--
-- Frequency is affordable because the gate lives HERE, in the where clause,
-- not inside the function. When there is nothing to do, net.http_post never
-- executes and no Edge Function is ever started -- the whole tick is one cheap
-- query. Putting the gate in the function instead would wake it 288 times a
-- day to read one row and return.
create extension if not exists pg_cron;
create extension if not exists pg_net;

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
      body    := jsonb_build_object('action', 'run')
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
      -- After a 402 the daily allowance is gone and Brevo's reset hour is not
      -- documented. Backing off keeps the schedule from re-probing every five
      -- minutes for the rest of the day; the function sets this timestamp.
      --
      -- app_config.value is NOT NULL, so "no backoff" is stored as the empty
      -- string. nullif is what keeps that from reaching ::timestamptz, which
      -- would raise and abort the whole job every five minutes.
      and (nullif(s.retry_after, '') is null
           or now() >= nullif(s.retry_after, '')::timestamptz);
  $job$
);
