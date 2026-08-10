-- 조 belongs to the participant, not to the match.
--
-- 20260808000013 split matches.team into male_team/female_team, which fixed the
-- CSV losing the man's 조 but kept 조 attached to the pairing. That is the wrong
-- owner: a match is assembled from two registered participants, and each brings
-- their own 조 with them. Storing it per match meant the same person could carry
-- a different 조 in every row they appear in, and every read had to work out
-- which side of the pairing the reader was on -- exactly the kind of question
-- that produced a participant being shown their partner's 조.
--
-- With the column on participants there is no side to pick: a person has one 조
-- and every screen reads the same value.
alter table participants add column team text;

-- Seed from whichever side each participant sat on. The two updates cannot
-- collide: a participant is referenced as male_id or as female_id, never both,
-- because matches always pair one of each gender.
update participants p
   set team = m.male_team
  from matches m
 where m.male_id = p.id
   and m.male_team is not null;

update participants p
   set team = m.female_team
  from matches m
 where m.female_id = p.id
   and m.female_team is not null;

alter table matches
  drop column male_team,
  drop column female_team;

-- Now reads mm.team / f.team instead of a column on the match. The signature is
-- unchanged: `team` is still the participant's own 조, it is just sourced from
-- the participant record rather than from the side they happen to sit on.
create or replace function public.matches_for_participant(p_id uuid)
returns table (
  session     text,
  time_range  text,
  arrive_by   text,
  venue       text,
  team        text,
  partner_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.session,
    m.time_range,
    m.arrive_by,
    m.venue,
    case when m.male_id = p_id then mm.team else f.team end,
    case when m.male_id = p_id then f.display_name else mm.display_name end
  from matches m
  join participants mm on mm.id = m.male_id
  join participants f  on f.id  = m.female_id
  where m.male_id = p_id or m.female_id = p_id
  order by m.session, m.venue;
$$;

revoke execute on function public.matches_for_participant(uuid) from public, anon, authenticated;
grant execute on function public.matches_for_participant(uuid) to service_role;

-- Same output columns as 20260808000013, so no drop is needed: male_team and
-- female_team are now read from the two participants rather than the match.
-- The admin table keeps showing 조 beside each name; it just no longer owns it.
create or replace function public.admin_list_matches()
returns table (
  id               uuid,
  session          text,
  time_range       text,
  arrive_by        text,
  venue            text,
  male_team        text,
  female_team      text,
  male_id          uuid,
  male_name        text,
  male_birthdate   date,
  female_id        uuid,
  female_name      text,
  female_birthdate date
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.id, m.session, m.time_range, m.arrive_by, m.venue,
    mm.team, f.team,
    mm.id, mm.display_name, mm.birthdate,
    f.id,  f.display_name,  f.birthdate
  from matches m
  join participants mm on mm.id = m.male_id
  join participants f  on f.id  = m.female_id
  order by m.session, m.venue, mm.team nulls last;
$$;

revoke execute on function public.admin_list_matches() from public, anon, authenticated;
grant execute on function public.admin_list_matches() to service_role;

-- Unchanged from 20260808000013 except that `team` moves from the matches
-- INSERT to the participants upsert. Every comment in the upsert is that
-- migration's; see it for the sentinel resolution and claim-column reasoning.
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
  -- The sentinel ("keep existing code") is resolved here, in the SELECT that
  -- feeds the INSERT, rather than in an ON CONFLICT DO UPDATE SET clause.
  -- Postgres runs ExecConstraints (NOT NULL/CHECK) against the row an
  -- INSERT ... ON CONFLICT DO UPDATE is about to insert *before* it detects
  -- the conflict and applies the SET clause, so a CASE expression in SET
  -- never gets a chance to matter: an empty-sentinel row fails
  -- participants_code_not_empty on the speculative insert regardless of what
  -- the eventual UPDATE would have produced. Resolving against the existing
  -- row up front means the same non-empty value is present at every check
  -- point. For a genuinely new participant there is no existing row to fall
  -- back to, so the trailing '' keeps the sentinel as an empty string and
  -- lets the CHECK constraint reject it, exactly as intended.
  insert into participants (
    name, display_name, birthdate, gender, contact, email, team,
    code_salt, code_hash
  )
  select
    p ->> 'name',
    p ->> 'display_name',
    (p ->> 'birthdate')::date,
    p ->> 'gender',
    nullif(p ->> 'contact', ''),
    nullif(p ->> 'email', ''),
    nullif(p ->> 'team', ''),
    coalesce(nullif(p ->> 'code_salt', ''), existing.code_salt, ''),
    coalesce(nullif(p ->> 'code_hash', ''), existing.code_hash, '')
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
    code_salt    = excluded.code_salt,
    code_hash    = excluded.code_hash,
    -- A re-import is the admin's most natural way to fix a typo'd address or
    -- retry a bounced send: it must reopen the row for claim_pending_codes,
    -- regardless of whether the code changed.
    send_attempts   = 0,
    send_last_error = null,
    -- Only when the code OR the email changed is an in-flight claim
    -- invalidated. A code change invalidates it because the run is about to
    -- (or already did) mail a code the database no longer holds. An email
    -- change invalidates it because the run is about to (or already did)
    -- mail the OLD, wrong address -- its stamp() would otherwise still
    -- succeed under the untouched claim and mark this row done while the
    -- corrected address never received anything. When NEITHER changed, a run
    -- that is mid-flight sending the current code to the current address must
    -- be allowed to finish: clearing the claim here would make its later
    -- stamp() (guarded by `eq("send_claim_id", runId)`) a no-op, leaving
    -- code_sent_at null and causing a second, redundant mail next run.
    send_claim_id = case
      when excluded.code_salt is distinct from participants.code_salt
        or excluded.code_hash is distinct from participants.code_hash
        or excluded.email is distinct from participants.email
      then null
      else participants.send_claim_id
    end,
    send_claimed_at = case
      when excluded.code_salt is distinct from participants.code_salt
        or excluded.code_hash is distinct from participants.code_hash
        or excluded.email is distinct from participants.email
      then null
      else participants.send_claimed_at
    end,
    -- Only when the code itself changed (see the claim columns above for the
    -- same comparison and the same reasoning) does the participant become
    -- unnotified. An import that leaves the code untouched must leave
    -- code_sent_at untouched too, or an already-notified participant would be
    -- queued for a second, redundant mail -- an address-only fix intentionally
    -- does NOT reopen code_sent_at; the claim-column change above is what
    -- gets the corrected address a code, by letting an in-flight send to the
    -- old address abort instead of falsely marking the row sent.
    code_sent_at = case
      when excluded.code_salt is distinct from participants.code_salt
        or excluded.code_hash is distinct from participants.code_hash
      then null
      else participants.code_sent_at
    end;

  -- "where true" is required, not decorative. PostgREST connects as the
  -- `authenticator` role, whose session has pg_safeupdate preloaded, and that
  -- rejects an unqualified DELETE with SQLSTATE 21000 even inside a
  -- security-definer function. Since RPC over PostgREST is the only way the
  -- Edge Functions can reach this function, an unqualified DELETE here makes
  -- the import impossible to run at all.
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

  -- The INSERT above uses INNER JOINs against participants, so any match row
  -- whose (name, birthdate) pair does not resolve to a participant -- a
  -- normalization mismatch, a typo, or a participant missing from this same
  -- payload -- is silently dropped instead of inserted. Compare the number of
  -- rows actually inserted against the number of match objects in the
  -- payload and abort rather than accepting a partial import: the caller
  -- would otherwise report success using the parsed count, not the landed
  -- count, and the participants affected by the dropped rows would show up
  -- to the event with no partner. Raising here rolls back the participants
  -- upsert above too, since the whole function body is one transaction.
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
