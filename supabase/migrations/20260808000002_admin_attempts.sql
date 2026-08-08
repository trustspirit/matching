-- Admin auth failures are counted separately from participant logins on
-- purpose. The participant threshold (30/min) is deliberately high because
-- ~350 people share one venue egress IP; the admin is one person and needs a
-- low threshold. Sharing one table would let participant typos lock out the
-- admin, and would also mean touching the code path 350 people traverse on
-- event day.
create table public.admin_attempts (
  id           uuid primary key default gen_random_uuid(),
  ip_hash      text not null,
  attempted_at timestamptz not null default now()
);

create index admin_attempts_lookup_idx
  on public.admin_attempts (ip_hash, attempted_at desc);

alter table public.admin_attempts enable row level security;

-- See 20260807000003_grants.sql. No sequence grant is needed here because the
-- primary key is a uuid default, not a bigserial.
grant select, insert on public.admin_attempts to service_role;
