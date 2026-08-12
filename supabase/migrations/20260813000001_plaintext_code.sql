-- Store the code itself instead of a salted digest of it.
--
-- Hashing a credential earns its keep when the credential is reused elsewhere
-- (a password) or when the hash guards something the same dump does not
-- already contain. Neither holds here. A code is a random six-character string
-- minted for this event alone, and everything it unlocks -- the participant
-- list, who is matched with whom, when and where -- sits in plaintext two
-- tables over. An attacker holding this database has already read all of it
-- without touching a single hash.
--
-- What the digest did cost was real. Because every row carried its own salt,
-- a code could not be looked up: login had to read all ~350 participants and
-- hash the input once per row, and minting had to hash each candidate against
-- every stored salt (~122k SHA-256 for a full import). Worse, the plaintext
-- existed only in the HTTP response that minted it, so "email this person
-- their code" was impossible -- the send path had to mint a NEW code and
-- invalidate the one already handed out. A rejected send then left the
-- participant with a code nobody, including the organiser, could name.
--
-- The digest was also weaker than it looked: 30^6 is 7.29e8 candidates behind
-- a single SHA-256, which a GPU walks through in seconds per row.
alter table public.participants add column code text;

-- Backfill. The plaintext of the existing codes is gone by construction, so
-- every participant gets a new one -- safe here only because no code has
-- reached anyone yet (every send so far was rejected by Brevo for an
-- unvalidated sender address).
--
-- gen_random_uuid() rather than random(): these are credentials, and random()
-- is a deterministic PRNG. It is also built in, unlike pgcrypto's
-- gen_random_bytes, so this does not depend on where the extension happens to
-- be installed. The first 12 hex characters of a v4 UUID are six fully random
-- bytes; the version and variant nibbles sit later in the string and are
-- never read here.
do $$
declare
  -- Must stay in step with CODE_ALPHABET in functions/_shared/lib/code.ts.
  -- 0/1/I/L/O/U are absent so a code survives being copied by hand.
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  -- floor(256 / 30) * 30. Bytes at or above this are discarded rather than
  -- folded with %, which would make the first 16 letters likelier than the
  -- rest.
  cutoff   constant int  := 240;
  target   record;
  hex      text;
  candidate text;
  b        int;
  i        int;
begin
  for target in select id from public.participants loop
    loop
      candidate := '';
      while length(candidate) < 6 loop
        hex := replace(gen_random_uuid()::text, '-', '');
        for i in 0..5 loop
          exit when length(candidate) = 6;
          b := ('x' || substr(hex, i * 2 + 1, 2))::bit(8)::int;
          if b < cutoff then
            candidate := candidate || substr(alphabet, (b % 30) + 1, 1);
          end if;
        end loop;
      end loop;
      exit when not exists (
        select 1 from public.participants where code = candidate
      );
    end loop;
    update public.participants set code = candidate where id = target.id;
  end loop;
end $$;

alter table public.participants
  alter column code set not null,
  add constraint participants_code_not_blank check (code <> '');

-- Uniqueness is finally expressible as a constraint. Under per-row salts it
-- could only be enforced by hashing every candidate against every stored
-- salt in application code, which is what mintUniqueCode() existed to do.
create unique index participants_code_key on public.participants (code);

-- Dropping these also drops participants_code_not_empty, which referenced
-- both columns.
alter table public.participants
  drop column code_salt,
  drop column code_hash;

-- Every code just changed, so any earlier "sent" is a claim about a code that
-- no longer exists. Reopening the queue here keeps the admin screen honest;
-- automatic sending is off (code_send_armed defaults to false) so this does
-- not start mailing anyone.
update public.participants
   set code_sent_at    = null,
       send_attempts   = 0,
       send_last_error = null,
       send_claim_id   = null,
       send_claimed_at = null
 where true;

-- Hands the code to the caller so a send no longer has to mint one. This is
-- the whole point of the change: send-codes can now mail the code the row
-- already holds instead of replacing it first.
--
-- Adding an output column changes the result type, which `create or replace`
-- refuses; the signature is unchanged, so the old definition has to go first.
drop function if exists public.claim_pending_codes(uuid, int, int);

create function public.claim_pending_codes(
  p_run_id       uuid,
  p_limit        int,
  p_max_attempts int
)
returns table (
  id           uuid,
  display_name text,
  email        text,
  code         text
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
  returning p.id, p.display_name, p.email, p.code;
$$;

-- See 20260808000003_admin_data.sql: Postgres grants EXECUTE to PUBLIC by
-- default, so revoking from PUBLIC also locks out service_role. The grant back
-- is required, not decorative.
revoke execute on function public.claim_pending_codes(uuid, int, int)
  from public, anon, authenticated;
grant execute on function public.claim_pending_codes(uuid, int, int) to service_role;

-- Unchanged from 20260808000014 except that the code sentinel is now one
-- column instead of two. See that migration for the reasoning behind
-- resolving the sentinel in the SELECT and behind each claim-column CASE.
create or replace function public.import_matches(payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_matches_expected int;
  v_matches_inserted int;
begin
  insert into participants (
    name, display_name, birthdate, gender, contact, email, team, code
  )
  select
    p ->> 'name',
    p ->> 'display_name',
    (p ->> 'birthdate')::date,
    p ->> 'gender',
    nullif(p ->> 'contact', ''),
    nullif(p ->> 'email', ''),
    nullif(p ->> 'team', ''),
    -- Empty means "keep whatever this participant already has", so re-uploading
    -- to fix a 조 never invalidates a code that has gone out. A brand-new
    -- participant has no existing row to fall back to, so the trailing ''
    -- survives and participants_code_not_blank rejects the row rather than
    -- creating someone who can never log in.
    coalesce(nullif(p ->> 'code', ''), existing.code, '')
  from jsonb_array_elements(payload -> 'participants') as p
  left join participants existing
    on existing.name = p ->> 'name'
   and existing.birthdate = (p ->> 'birthdate')::date
  on conflict (name, birthdate) do update set
    display_name = excluded.display_name,
    gender       = excluded.gender,
    contact      = excluded.contact,
    email        = excluded.email,
    team         = excluded.team,
    code         = excluded.code,
    -- A re-import is the admin's most natural way to fix a typo'd address or
    -- retry a bounced send: it must reopen the row for claim_pending_codes,
    -- regardless of whether the code changed.
    send_attempts   = 0,
    send_last_error = null,
    send_claim_id = case
      when excluded.code is distinct from participants.code
        or excluded.email is distinct from participants.email
      then null
      else participants.send_claim_id
    end,
    send_claimed_at = case
      when excluded.code is distinct from participants.code
        or excluded.email is distinct from participants.email
      then null
      else participants.send_claimed_at
    end,
    code_sent_at = case
      when excluded.code is distinct from participants.code
      then null
      else participants.code_sent_at
    end;

  -- "where true" is required, not decorative. PostgREST connects as the
  -- `authenticator` role, whose session has pg_safeupdate preloaded, and that
  -- rejects an unqualified DELETE with SQLSTATE 21000 even inside a
  -- security-definer function.
  delete from matches where true;

  insert into matches (session, time_range, arrive_by, venue, male_id, female_id)
  select
    m ->> 'session',
    m ->> 'time_range',
    m ->> 'arrive_by',
    m ->> 'venue',
    mp.id,
    fp.id
  from jsonb_array_elements(payload -> 'matches') as m
  join participants mp
    on mp.name = m ->> 'male_name'
   and mp.birthdate = (m ->> 'male_birthdate')::date
  join participants fp
    on fp.name = m ->> 'female_name'
   and fp.birthdate = (m ->> 'female_birthdate')::date;

  -- The INNER JOINs above silently drop any match row whose (name, birthdate)
  -- pair does not resolve, which would send those participants to the event
  -- with no partner. Compare landed rows against the payload and roll the
  -- whole import back rather than report success on a partial one.
  get diagnostics v_matches_inserted = row_count;
  v_matches_expected := jsonb_array_length(payload -> 'matches');
  if v_matches_inserted <> v_matches_expected then
    raise exception
      'import_matches: expected % match row(s) but only % were inserted; a match row references a participant (name, birthdate) pair that is not present in the participants list',
      v_matches_expected, v_matches_inserted;
  end if;
end;
$$;

revoke execute on function public.import_matches(jsonb) from public, anon, authenticated;
grant execute on function public.import_matches(jsonb) to service_role;
