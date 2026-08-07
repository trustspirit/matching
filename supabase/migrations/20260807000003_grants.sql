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
-- as service_role, so every direct table query (the lookup function's
-- participants select, and rateLimit.ts's login_attempts select/insert) was
-- failing with "permission denied for table ..." even though RLS itself was
-- configured correctly.
grant select, insert, update, delete
  on public.participants, public.matches, public.login_attempts
  to service_role;

-- login_attempts.id is bigserial; inserting a row also needs sequence usage.
grant usage, select on all sequences in schema public to service_role;
