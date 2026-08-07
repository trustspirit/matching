-- Core schema for the blind-date match lookup site.
create extension if not exists pgcrypto;

create table public.participants (
  id           uuid primary key default gen_random_uuid(),
  -- Normalized lookup key: NFC, whitespace stripped, lower-cased, aliases applied.
  name         text not null,
  -- Original spelling as it appeared in the source data.
  display_name text not null,
  birthdate    date not null,
  gender       text not null check (gender in ('M', 'F')),
  contact      text,
  email        text,
  -- Per-row random salt; the plaintext code is never stored.
  code_salt    text not null,
  code_hash    text not null,
  created_at   timestamptz not null default now(),
  -- (name, birthdate) is unique across all 279 participants in the source data,
  -- which is why it is the identity key rather than email. Three pairs of
  -- participants share an email address.
  constraint participants_identity_key unique (name, birthdate)
);

create index participants_name_idx on public.participants (name);

create table public.matches (
  id         uuid primary key default gen_random_uuid(),
  session    text not null check (session in ('1부', '2부')),
  time_range text not null,
  arrive_by  text not null,
  venue      text not null,
  -- Null until the organizer assigns teams.
  team       text,
  male_id    uuid not null references public.participants (id) on delete cascade,
  female_id  uuid not null references public.participants (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index matches_male_idx on public.matches (male_id);
create index matches_female_idx on public.matches (female_id);

create table public.login_attempts (
  id           bigserial primary key,
  -- sha256(ip + IP_HASH_SALT); the raw address is never stored.
  ip_hash      text not null,
  succeeded    boolean not null,
  attempted_at timestamptz not null default now()
);

create index login_attempts_lookup_idx
  on public.login_attempts (ip_hash, attempted_at desc);

-- RLS with zero policies means "deny all". Only service_role bypasses it,
-- and service_role exists only inside the Edge Functions.
alter table public.participants   enable row level security;
alter table public.matches        enable row level security;
alter table public.login_attempts enable row level security;
