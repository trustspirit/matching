-- The result card is partner-centric: it leads with "상대방 / <이름>" and then
-- lists 시간 / 장소 / 조. That 조 was the viewer's own, so a participant read it
-- as their partner's and reported the partner being in the wrong 조 -- the data
-- was right, the card just never had the partner's 조 to show.
--
-- Returning both lets the screen label each one. `team` keeps its meaning (the
-- viewer's own 조, which is also what the admin delete-impact list reads), and
-- partner_team is added beside it.
--
-- Dropped rather than replaced: CREATE OR REPLACE cannot add an OUT column
-- (SQLSTATE 42P13). The grants below are re-issued because DROP takes the old
-- ones with it.
drop function if exists public.matches_for_participant(uuid);

create function public.matches_for_participant(p_id uuid)
returns table (
  session      text,
  time_range   text,
  arrive_by    text,
  venue        text,
  team         text,
  partner_team text,
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
    case when m.male_id = p_id then f.team else mm.team end,
    case when m.male_id = p_id then f.display_name else mm.display_name end
  from matches m
  join participants mm on mm.id = m.male_id
  join participants f  on f.id  = m.female_id
  where m.male_id = p_id or m.female_id = p_id
  order by m.session, m.venue;
$$;

revoke execute on function public.matches_for_participant(uuid) from public, anon, authenticated;
grant execute on function public.matches_for_participant(uuid) to service_role;
