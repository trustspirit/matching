-- Server side of the admin session. Only the SHA-256 of the token is stored,
-- the same principle as participant codes: a leaked table must not hand out
-- working credentials.
--
-- No per-row salt here, unlike participants. A salt exists to stop rainbow
-- tables against low-entropy secrets; the token is 32 random bytes, so
-- precomputation is not a threat. A salt would also force a full-table scan on
-- every request, since the row could not be found by hash.
create table public.admin_sessions (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index admin_sessions_expiry_idx on public.admin_sessions (expires_at);

alter table public.admin_sessions enable row level security;

-- See 20260807000003_grants.sql: RLS bypass is not enough, service_role needs
-- the table grant too, and the failure only shows up at runtime.
grant select, insert, delete on public.admin_sessions to service_role;
