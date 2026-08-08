-- 20260807000003_grants.sql said a later task needing direct writes should
-- grant exactly what it needs in its own migration. This is that task: the
-- admin table UI edits rows one at a time instead of replacing everything
-- through import_matches.
grant select, insert, update, delete on public.participants to service_role;
grant select, insert, update, delete on public.matches      to service_role;

-- matches references participants twice (male_id, female_id), which makes
-- PostgREST's embedding syntax ambiguous -- the same reason
-- matches_for_participant exists as an RPC. Joining here keeps the Edge
-- Function from having to stitch two queries together.
create or replace function public.admin_list_matches()
returns table (
  id               uuid,
  session          text,
  time_range       text,
  arrive_by        text,
  venue            text,
  team             text,
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
    m.id, m.session, m.time_range, m.arrive_by, m.venue, m.team,
    mm.id, mm.display_name, mm.birthdate,
    f.id,  f.display_name,  f.birthdate
  from matches m
  join participants mm on mm.id = m.male_id
  join participants f  on f.id  = m.female_id
  order by m.session, m.venue, m.team nulls last;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default and
-- service_role has no grant of its own, so revoking from PUBLIC locks out
-- service_role too. The explicit grant back is required, not decorative.
revoke execute on function public.admin_list_matches() from public, anon, authenticated;
grant execute on function public.admin_list_matches() to service_role;
