-- Sample data covering every edge case the UI has to survive.
-- Codes are fixed (TESTA2..TESTAC) so developers can log in repeatedly.
-- Production imports always generate random codes.
-- This is development-only data and never ships to production.

insert into public.participants
  (name, display_name, birthdate, gender, contact, email, team, code)
values
  -- Case 1: ordinary 1부 pair with a team assigned
  ('김효준', '김효준', '2004-06-24', 'M', '010-389-5611', 'konanok20@example.com',
   '3조', 'TESTA2'),
  ('정예림', '정예림', '2004-03-04', 'F', '010-3793-8478', 'yljun3064@example.com',
   '3조', 'TESTA3'),

  -- Participant in the Case 4 match below (team still undecided with 윤모습)
  ('박한서', '박한서', '2002-05-11', 'M', '010-1111-2222', 'hanseo@example.com',
   null, 'TESTA4'),

  -- Case 3: woman attending twice (1부 + 2부) with different men.
  -- 정예림 above is her 1부 partner's match; 윤모습 is the twice-attending one.
  ('윤모습', '윤모습', '2001-04-26', 'F', '010-3333-4444', 'yoonms@example.com',
   '6조', 'TESTA5'),
  ('엄태건', '엄태건', '2000-09-02', 'M', '010-5555-6666', 'etg@example.com',
   '1조', 'TESTA6'),

  -- Case 5: two different people who share a name (distinct birthdates + codes).
  -- The second one (1995-09-07), paired with 김은해 below, is also Case 2:
  -- ordinary 2부 pair with a team assigned.
  ('김시현', '김시현', '2001-04-11', 'M', '010-8697-1910', 'shared@example.com',
   '2조', 'TESTA7'),
  ('김시현', '김시현', '1995-09-07', 'M', '010-6767-8405', 'shared@example.com',
   '4조', 'TESTA8'),
  ('윤해서', '윤해서', '2001-03-03', 'F', '010-2832-4580', 'mae08099@example.com',
   '2조', 'TESTA9'),
  ('김은해', '김은해', '1996-01-15', 'F', '010-7777-8888', 'eunhae@example.com',
   '4조', 'TESTAB'),

  -- Case 6: participant with no match at all (excluded from matching)
  ('이승준', '이승준', '1998-12-14', 'M', '010-8521-0025', 'skyjune98@example.com',
   '5조', 'TESTAC');

-- Case 1: ordinary 1부 pair with a team assigned
insert into public.matches (session, time_range, arrive_by, venue, male_id, female_id)
select '1부', '21:50~22:20', '21:50', '소극장', m.id, f.id
from public.participants m, public.participants f
where m.name = '김효준' and f.name = '정예림';

-- Case 4: team is still undecided
insert into public.matches (session, time_range, arrive_by, venue, male_id, female_id)
select '2부', '22:40~23:00', '22:40', '골드', m.id, f.id
from public.participants m, public.participants f
where m.name = '박한서' and f.name = '윤모습';

-- Case 3 continued: 윤모습's second appearance, in 1부 with a different man.
-- Also Case 7: the pair sit in different 조 (엄태건 1조, 윤모습 6조), which is
-- normal now that 조 belongs to the person rather than to the pairing.
insert into public.matches (session, time_range, arrive_by, venue, male_id, female_id)
select '1부', '21:50~22:20', '21:50', '실버', m.id, f.id
from public.participants m, public.participants f
where m.name = '엄태건' and f.name = '윤모습';

-- Case 5 continued: the two 김시현s get different partners
insert into public.matches (session, time_range, arrive_by, venue, male_id, female_id)
select '1부', '21:50~22:20', '21:50', '마루', m.id, f.id
from public.participants m, public.participants f
where m.name = '김시현' and m.birthdate = '2001-04-11' and f.name = '윤해서';

-- Case 5 continued (second 김시현) and Case 2: ordinary 2부 pair with a team assigned
insert into public.matches (session, time_range, arrive_by, venue, male_id, female_id)
select '2부', '22:40~23:00', '22:40', '마루', m.id, f.id
from public.participants m, public.participants f
where m.name = '김시현' and m.birthdate = '1995-09-07' and f.name = '김은해';
