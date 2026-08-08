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
insert into public.app_config (key, value)
values ('ip_hash_salt', encode(gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

-- See 20260807000003_grants.sql: service_role needs an explicit table grant.
-- RLS bypass alone is not enough and the failure only appears at runtime.
grant select on public.app_config to service_role;
