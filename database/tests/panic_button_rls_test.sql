-- ANCHOR: Panic Button RLS check for the shared Supabase project.
-- Run in the Supabase SQL Editor AFTER the panic button SQL files are applied.
-- Needs at least 2 users in Authentication > Users (the first two are used).
--
-- The result appears as an ERROR message on purpose. That is how this script
-- guarantees NOTHING is saved: the error rolls back every test row it created.
do $$
declare
  a uuid; b uuid;
  a_sees int; b_sees int; b_upd int; b_del int; b_ins text;
begin
  select id into a from auth.users order by created_at limit 1;
  select id into b from auth.users order by created_at offset 1 limit 1;
  if a is null or b is null then
    raise exception 'Need at least 2 users in Authentication > Users first.';
  end if;

  -- act as user A
  perform set_config('request.jwt.claims',
    json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.panic_events (user_id, urge_level, trigger_note)
    values (a, 7, 'rls test');
  select count(*) into a_sees from public.panic_events where trigger_note = 'rls test';

  -- act as user B
  perform set_config('request.jwt.claims',
    json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select count(*) into b_sees from public.panic_events where trigger_note = 'rls test';
  update public.panic_events set outcome = 'resolved' where trigger_note = 'rls test';
  get diagnostics b_upd = row_count;
  delete from public.panic_events where trigger_note = 'rls test';
  get diagnostics b_del = row_count;
  begin
    insert into public.panic_events (user_id) values (a);
    b_ins := 'NOT BLOCKED (bad)';
  exception when others then
    b_ins := 'blocked (good)';
  end;

  reset role;
  raise exception E'RLS TEST RESULT (nothing was saved)\nUser A sees own test event: % (expect 1)\nUser B sees A''s event: % (expect 0)\nUser B updated A''s rows: % (expect 0)\nUser B deleted A''s rows: % (expect 0)\nUser B inserting a row as A: % (expect blocked)',
    a_sees, b_sees, b_upd, b_del, b_ins;
end
$$;
