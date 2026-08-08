-- Server-generated configuration values. Keeping the IP hash salt here instead
-- of in a Supabase secret removes the last deployment value a human has to
-- invent, and removes the risk of a weak hand-written salt.
create table public.app_config (
  key   text primary key,
  value text not null
);

-- RLS with zero policies means deny all, matching 20260807000001_init.sql.
alter table public.app_config enable row level security;

-- `on conflict do nothing` is load-bearing. Without it, re-running `db push`
-- would mint a new salt, every existing login_attempts.ip_hash would stop
-- matching, and the rate limiter would silently stop throttling.
--
-- Built from gen_random_uuid() rather than pgcrypto's gen_random_bytes().
-- pgcrypto installs into `public` locally but into the `extensions` schema on
-- Supabase's hosted platform, which is not on the migration search_path, so
-- gen_random_bytes() resolves locally and fails on deploy with
-- "function gen_random_bytes(integer) does not exist". Schema-qualifying it as
-- extensions.gen_random_bytes() would invert the problem and break locally.
-- gen_random_uuid() is a Postgres 13+ core function in pg_catalog, backed by
-- the same strong RNG, so it resolves identically in both environments.
-- Two UUIDs stripped of dashes give the same 64 hex characters as before.
insert into public.app_config (key, value)
values (
  'ip_hash_salt',
  replace(gen_random_uuid()::text, '-', '') ||
    replace(gen_random_uuid()::text, '-', '')
)
on conflict (key) do nothing;

-- See 20260807000003_grants.sql: service_role needs an explicit table grant.
-- RLS bypass alone is not enough and the failure only appears at runtime.
grant select on public.app_config to service_role;
