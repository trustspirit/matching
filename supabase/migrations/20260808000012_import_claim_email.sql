-- F5 fix: ...0011 cleared send_claim_id / send_claimed_at only when the code
-- changed, which is right for codes but wrong for addresses. Re-importing a
-- CSV that only fixes a typo'd email leaves the claim in place: an in-flight
-- run still holds the OLD email in memory, mails it, and its stamp() (guarded
-- by `.eq("send_claim_id", runId)`) still succeeds because the claim was
-- never invalidated -- so code_sent_at is set and the corrected address never
-- gets a code. ...0011's own comment calls re-import "the admin's most
-- natural fix for a typo'd address", which is exactly the case this breaks.
--
-- Fix: clear the claim columns when the code changes OR the email changes.
-- Everything else about import_matches is unchanged from ...0011, including
-- code_sent_at, which stays keyed on the code alone -- see that migration's
-- comment for why an address-only fix must not force a redundant second mail
-- to someone who already has a valid, already-sent code at their new address.
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

-- Same reasoning as matches_for_participant above: revoking from PUBLIC
-- also removes service_role's only path to this function.
revoke execute on function public.import_matches(jsonb) from public, anon, authenticated;
grant execute on function public.import_matches(jsonb) to service_role;
