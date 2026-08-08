-- Sending a few hundred codes cannot finish inside one Edge Function
-- invocation (150s wall clock) or one Brevo free-plan day (300 messages), so
-- it becomes a resumable job that several runs -- cron and the admin screen --
-- may enter concurrently. These columns make "who is being sent right now"
-- explicit so two runs cannot mail the same person.
alter table public.participants
  add column send_claim_id   uuid,
  add column send_claimed_at timestamptz,
  add column send_attempts   int not null default 0,
  add column send_last_error text;

comment on column public.participants.send_claim_id is
  'The run currently sending to this participant. Every write around a send is guarded by this value, so re-minting the code cancels an in-flight send by replacing it.';
comment on column public.participants.send_attempts is
  'Consecutive send failures. At 5 the row drops out of the queue so one typo cannot make cron repeat the same failure daily. Editing the participant or reissuing their code resets it.';

-- No index. The table holds a few hundred rows; a partial index on
-- code_sent_at would cost more to maintain than the sequential scan it saves.

-- Atomic claim. PostgREST cannot express "select these rows and mark them in
-- one statement", and without that atomicity two concurrent runs read the same
-- pending set and both send.
--
-- `for update skip locked` is what lets a second run make progress instead of
-- blocking: it walks past rows the first run already holds.
create or replace function public.claim_pending_codes(
  p_run_id uuid,
  p_limit  int
)
returns table (
  id           uuid,
  display_name text,
  email        text
)
language sql
volatile
security definer
set search_path = public
as $$
  update participants p
     set send_claim_id   = p_run_id,
         send_claimed_at = now()
   where p.id in (
     select c.id
       from participants c
      where c.email is not null
        and c.email <> ''
        and c.code_sent_at is null
        and c.send_attempts < 5
        -- A claim older than five minutes belonged to a run that died -- the
        -- wall clock kills functions mid-loop. Without this the row would stay
        -- locked forever and that participant would never get their code.
        and (c.send_claim_id is null
             or c.send_claimed_at < now() - interval '5 minutes')
      order by c.display_name
      limit p_limit
      for update skip locked
   )
  returning p.id, p.display_name, p.email;
$$;

-- See 20260808000003_admin_data.sql: Postgres grants EXECUTE to PUBLIC by
-- default, so revoking from PUBLIC also locks out service_role. The grant back
-- is required, not decorative.
revoke execute on function public.claim_pending_codes(uuid, int)
  from public, anon, authenticated;
grant execute on function public.claim_pending_codes(uuid, int) to service_role;

-- Automatic sending stays off until an admin arms it. A CSV import followed by
-- proofreading must not put mail in anyone's inbox, and mail cannot be
-- recalled.
insert into public.app_config (key, value)
values ('code_send_armed', 'false')
on conflict (key) do nothing;

-- Shared secret between the cron job and the send-codes function. Generated
-- here for the same reason ip_hash_salt is (see 20260808000001_app_config.sql):
-- a value a human invents is one more thing to get wrong, and both sides of
-- this handshake can already reach the database.
insert into public.app_config (key, value)
values (
  'cron_secret',
  replace(gen_random_uuid()::text, '-', '') ||
    replace(gen_random_uuid()::text, '-', '')
)
on conflict (key) do nothing;

-- send_codes_url is written by the send-codes function itself on the first
-- authenticated admin request; nothing seeds it here because only the running
-- function knows its own public URL.

-- 20260808000001_app_config.sql granted select only. Arming, disarming and
-- recording the function URL are writes.
grant update, insert on public.app_config to service_role;
