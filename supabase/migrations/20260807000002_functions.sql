-- Returns every match a participant belongs to, from either side of the pair.
-- Exists as an RPC because matches references participants twice, which makes
-- PostgREST's embedding syntax ambiguous.
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
    m.team,
    case when m.male_id = p_id then f.display_name else mm.display_name end
  from matches m
  join participants mm on mm.id = m.male_id
  join participants f  on f.id  = m.female_id
  where m.male_id = p_id or m.female_id = p_id
  order by m.session, m.venue;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default, and
-- service_role has no explicit grant of its own. Revoking from PUBLIC
-- therefore locks out service_role too, so it must be granted back
-- explicitly or the Edge Functions get "permission denied for function".
revoke execute on function public.matches_for_participant(uuid) from public, anon, authenticated;
grant execute on function public.matches_for_participant(uuid) to service_role;

-- Replaces the entire match set in one transaction.
--
-- payload = {
--   "participants": [{ name, display_name, birthdate, gender, contact, email,
--                      code_salt, code_hash }],
--   "matches":      [{ session, time_range, arrive_by, venue, team,
--                      male_name, male_birthdate, female_name, female_birthdate }]
-- }
--
-- An empty code_salt/code_hash means "keep whatever this participant already
-- has", so re-uploading to add team numbers never invalidates codes that were
-- already handed out.
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
    name, display_name, birthdate, gender, contact, email, code_salt, code_hash
  )
  select
    p ->> 'name',
    p ->> 'display_name',
    (p ->> 'birthdate')::date,
    p ->> 'gender',
    nullif(p ->> 'contact', ''),
    nullif(p ->> 'email', ''),
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
    code_salt    = excluded.code_salt,
    code_hash    = excluded.code_hash;

  -- "where true" is required, not decorative. PostgREST connects as the
  -- `authenticator` role, whose session has pg_safeupdate preloaded, and that
  -- rejects an unqualified DELETE with SQLSTATE 21000 even inside a
  -- security-definer function. Since RPC over PostgREST is the only way the
  -- Edge Functions can reach this function, an unqualified DELETE here makes
  -- the import impossible to run at all.
  delete from matches where true;

  insert into matches (session, time_range, arrive_by, venue, team, male_id, female_id)
  select
    m ->> 'session',
    m ->> 'time_range',
    m ->> 'arrive_by',
    m ->> 'venue',
    nullif(m ->> 'team', ''),
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
  -- whose (name, birthdate) pair does not resolve to a participant — a
  -- normalization mismatch, a typo, or a participant missing from this same
  -- payload — is silently dropped instead of inserted. Compare the number of
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

-- Same reasoning as matches_for_participant above: revoking from PUBLIC
-- also removes service_role's only path to this function.
revoke execute on function public.import_matches(jsonb) from public, anon, authenticated;
grant execute on function public.import_matches(jsonb) to service_role;
