-- Hold each session's partner back until that session actually starts.
--
-- Knowing who you are paired with an hour early takes the evening apart: the
-- pairing gets discussed before anyone sits down, and someone who does not
-- like what they read simply does not arrive. The lookup screen therefore
-- withholds the partner's name and 조 until the session begins, and it does so
-- on the server -- the response itself must not carry the name, or opening the
-- network tab defeats the whole thing.
--
-- Stored per session rather than as one event timestamp because the two
-- sessions open 50 minutes apart: at 9:50pm a 1부 participant may see their
-- partner while a 2부 participant may not.
--
-- The offset is explicit. Postgres stores timestamptz as an instant, the Edge
-- Functions run in UTC, and an organiser may open the admin screen from a
-- laptop set to another country; "21:50" alone would mean a different moment
-- to each of them. +09:00 is exact rather than approximate -- Korea has had no
-- daylight saving since 1988.
--
-- These are the defaults for the 2026-08-14 event. The admin screen edits
-- them, so a delay on the night does not need a deploy.
insert into public.app_config (key, value)
values
  ('reveal_at_1부', '2026-08-14T21:50:00+09:00'),
  ('reveal_at_2부', '2026-08-14T22:40:00+09:00')
on conflict (key) do nothing;
