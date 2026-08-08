-- L2 fix: MAX_ATTEMPTS in send-codes/index.ts and the bare "5" this function
-- hardcoded (20260808000006) had to stay in lockstep by hand. Raising only
-- the TS constant would make pendingCount() (same file, same constant) count
-- rows this RPC can never return, so every run would end in "partial"
-- forever: permanently armed, zero sends, no error anywhere -- exactly the
-- trap the "partial" outcome exists to avoid. Taking the ceiling as a
-- parameter and passing MAX_ATTEMPTS from TypeScript makes the constant the
-- single source of truth.
--
-- Adding a parameter changes the function's signature, which creates a second
-- overload rather than replacing the first under `create or replace` -- drop
-- the old two-argument form explicitly so exactly one claim_pending_codes
-- exists.
drop function if exists public.claim_pending_codes(uuid, int);

create or replace function public.claim_pending_codes(
  p_run_id       uuid,
  p_limit        int,
  p_max_attempts int
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
        and c.send_attempts < p_max_attempts
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
revoke execute on function public.claim_pending_codes(uuid, int, int)
  from public, anon, authenticated;
grant execute on function public.claim_pending_codes(uuid, int, int) to service_role;
