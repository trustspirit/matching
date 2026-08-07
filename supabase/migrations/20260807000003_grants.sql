-- Migration 20260807000001 created participants/matches/login_attempts while
-- running as the `postgres` role. In this Supabase setup, default privileges
-- for tables owned by `postgres` grant anon/authenticated/service_role only
-- TRUNCATE/REFERENCES/TRIGGER/MAINTAIN -- not SELECT/INSERT/UPDATE/DELETE
-- (tables owned by `supabase_admin` get full default privileges instead, but
-- migrations never run as that role).
--
-- 20260807000001_init.sql documents the intent that "RLS with zero policies
-- means deny all: only service_role bypasses it", but that bypass applies to
-- row-level security only. The coarser table-level GRANT layer still blocks
-- service_role without an explicit grant, and Edge Functions run exclusively
-- as service_role, so direct table queries were failing with "permission
-- denied for table ..." even though RLS itself was configured correctly.
--
-- Grants are scoped to exactly what current Edge Function code does directly
-- (grep the diff, not anticipated future needs): the lookup function selects
-- candidate participants by name, and rateLimit.ts selects and inserts
-- login_attempts rows. Nothing queries `matches` directly -- it is only ever
-- reached through the `security definer` matches_for_participant/
-- import_matches RPCs, which run as the function owner and need no
-- service_role table grant at all. If a later task needs a direct write to
-- participants or matches, that task's own migration should grant exactly
-- what it needs then, not this one, preemptively.
grant select on public.participants to service_role;
grant select, insert on public.login_attempts to service_role;
grant usage, select on public.login_attempts_id_seq to service_role;
