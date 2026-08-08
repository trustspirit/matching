-- L3 fix: 20260808000009 got code_sent_at right -- cleared only when the code
-- actually changed -- but cleared send_claim_id / send_claimed_at
-- unconditionally. Those two must follow the exact same condition, for the
-- same reason.
--
-- Concretely: a run claims participant P, mints code X, writes it, and is
-- mid-flight sending the email. An admin re-imports a CSV in which P's code
-- is UNCHANGED. The unconditional clear wipes P's send_claim_id. The run's
-- stamp() (supabase/functions/send-codes/index.ts) is guarded by
-- `.eq("send_claim_id", runId)`, so it now writes zero rows: code_sent_at
-- stays null even though the mail has already gone out. On the next run P is
-- still pending, gets a fresh code Y, and is mailed a SECOND time.
--
-- Had the claim been left alone for an unchanged code, stamp() would have
-- succeeded, code_sent_at would have been set, and there would be no second
-- mail. Clearing the claim IS correct when the code changes -- that is the
-- intended cancellation: a new code must invalidate an in-flight send of the
-- old one. So the claim columns need the identical excluded vs. current
-- comparison already used for code_sent_at, not an unconditional null.
--
-- send_attempts and send_last_error are deliberately left unconditional: an
-- admin re-importing a corrected sheet is the explicit signal to re-open that
-- participant, regardless of whether the code changed.
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
    -- Only when the code itself changed (excluded.code_salt/code_hash differ
    -- from what is already stored on this row -- see the sentinel comment
    -- above) is an in-flight claim on the OLD code invalidated. excluded.code_salt
    -- was resolved from `existing`, i.e. this same conflicting row, so
    -- comparing it against participants.code_salt is exactly "did this import
    -- actually mint a new code for them". When the code is unchanged, a run
    -- that is mid-flight sending it must be allowed to finish: clearing the
    -- claim here would make its later stamp() (guarded by
    -- `eq("send_claim_id", runId)`) a no-op, leaving code_sent_at null and
    -- causing a second, redundant mail next run.
    send_claim_id = case
      when excluded.code_salt is distinct from participants.code_salt
        or excluded.code_hash is distinct from participants.code_hash
      then null
      else participants.send_claim_id
    end,
    send_claimed_at = case
      when excluded.code_salt is distinct from participants.code_salt
        or excluded.code_hash is distinct from participants.code_hash
      then null
      else participants.send_claimed_at
    end,
    -- Only when the code itself changed (see the claim columns above for the
    -- same comparison and the same reasoning) does the participant become
    -- unnotified. An import that leaves the code untouched must leave
    -- code_sent_at untouched too, or an already-notified participant would be
    -- queued for a second, redundant mail.
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
