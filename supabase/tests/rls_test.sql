\set ON_ERROR_STOP off
set client_min_messages = notice;
drop table if exists test_ctx; create table test_ctx(k text primary key, v text);
grant all on test_ctx to authenticated, anon;
truncate auth.users cascade;
insert into auth.users(id,email) values
 ('00000000-0000-0000-0000-00000000000a','a@x'),('00000000-0000-0000-0000-00000000000b','b@x'),('00000000-0000-0000-0000-00000000000c','c@x');
create or replace function t_result(name text, ok boolean, detail text default '') returns void language plpgsql as $$
begin raise notice '% : % %', case when ok then 'PASS' else 'FAIL' end, name, coalesce(detail,''); end $$;

-- 1. A creates a group
do $$ declare gid uuid; n int; begin
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',true);
  set local role authenticated;
  gid := public.create_group('Goa trip','₹','Asha',array['Ravi','Meena',' ','ravi']);
  select count(*) into n from members where group_id=gid;
  perform t_result('create_group: creator + 2 unique others (blank and duplicate ignored)', n=3, n::text);
  insert into test_ctx values ('gid',gid::text),
    ('a',(select id::text from members where group_id=gid and name='Asha')),
    ('r',(select id::text from members where group_id=gid and name='Ravi')),
    ('m',(select id::text from members where group_id=gid and name='Meena')),
    ('code',(select invite_code from groups where id=gid));
  reset role;
end $$;

-- 2. A saves, edits, and misuses save_expense
do $$ declare gid uuid:=(select v::uuid from test_ctx where k='gid'); a uuid:=(select v::uuid from test_ctx where k='a');
  r uuid:=(select v::uuid from test_ctx where k='r'); m uuid:=(select v::uuid from test_ctx where k='m'); eid uuid; n int; tot bigint; begin
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',true);
  set local role authenticated;
  eid := public.save_expense(null,gid,'Dinner',100000,a,current_date,'equal',
    jsonb_build_array(jsonb_build_object('member_id',a,'amount_minor',33334,'input_value',1),
                      jsonb_build_object('member_id',r,'amount_minor',33333,'input_value',1),
                      jsonb_build_object('member_id',m,'amount_minor',33333,'input_value',1)));
  perform t_result('A saves an equal expense', eid is not null);
  insert into test_ctx values ('eid',eid::text);
  begin perform public.save_expense(null,gid,'Bad',100000,a,current_date,'equal', jsonb_build_array(jsonb_build_object('member_id',a,'amount_minor',1)));
    perform t_result('split not adding up is rejected', false);
  exception when others then perform t_result('split not adding up is rejected', sqlerrm like 'The split adds up%', sqlerrm); end;
  begin perform public.save_expense(null,gid,'Dup',100,a,current_date,'equal', jsonb_build_array(jsonb_build_object('member_id',a,'amount_minor',50),jsonb_build_object('member_id',a,'amount_minor',50)));
    perform t_result('same person twice is rejected', false);
  exception when others then perform t_result('same person twice is rejected', sqlerrm like 'A person appears twice%', sqlerrm); end;
  begin perform public.save_expense(null,gid,'Neg',100,a,current_date,'exact', jsonb_build_array(jsonb_build_object('member_id',a,'amount_minor',200),jsonb_build_object('member_id',r,'amount_minor',-100)));
    perform t_result('negative share is rejected', false);
  exception when others then perform t_result('negative share is rejected', sqlerrm like 'A share cannot be negative%', sqlerrm); end;
  begin perform public.save_expense(null,gid,'Zero',0,a,current_date,'equal', jsonb_build_array(jsonb_build_object('member_id',a,'amount_minor',0)));
    perform t_result('zero amount is rejected', false);
  exception when others then perform t_result('zero amount is rejected', sqlerrm like 'Enter an amount above zero%', sqlerrm); end;
  perform public.save_expense(eid,gid,'Dinner (edited)',60000,r,current_date,'exact',
    jsonb_build_array(jsonb_build_object('member_id',a,'amount_minor',10000,'input_value',10000),jsonb_build_object('member_id',r,'amount_minor',50000,'input_value',50000)));
  select count(*), sum(amount_minor) into n, tot from expense_splits where expense_id=eid;
  perform t_result('edit replaces the old split', n=2 and tot=60000, n||' rows, '||tot);
  perform t_result('edit updates the expense', (select description||paid_by::text from expenses where id=eid)='Dinner (edited)'||r::text);
  reset role;
end $$;

-- 3. B is an outsider
do $$ declare gid uuid:=(select v::uuid from test_ctx where k='gid'); a uuid:=(select v::uuid from test_ctx where k='a'); code text:=(select v from test_ctx where k='code');
  r uuid:=(select v::uuid from test_ctx where k='r'); n int; pv jsonb; begin
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',true);
  set local role authenticated;
  perform t_result('outsider sees no groups', (select count(*) from groups)=0);
  perform t_result('outsider sees no members/expenses/splits/payments', (select count(*) from members)+(select count(*) from expenses)+(select count(*) from expense_splits)+(select count(*) from payments)=0);
  begin perform public.save_expense(null,gid,'Sneaky',100,a,current_date,'equal', jsonb_build_array(jsonb_build_object('member_id',a,'amount_minor',100)));
    perform t_result('outsider cannot add an expense', false);
  exception when others then perform t_result('outsider cannot add an expense', sqlerrm like 'You are not in this group%', sqlerrm); end;
  begin insert into groups(name) values ('Mine'); perform t_result('nobody can insert a group directly', false);
  exception when others then perform t_result('nobody can insert a group directly', sqlstate='42501', sqlerrm); end;
  begin insert into members(group_id,name) values (gid,'Intruder'); perform t_result('outsider cannot add a person', false);
  exception when others then perform t_result('outsider cannot add a person', sqlstate='42501', sqlerrm); end;
  begin perform public.rotate_invite_code(gid); perform t_result('outsider cannot rotate code', false);
  exception when others then perform t_result('outsider cannot rotate code', sqlerrm like 'You are not in this group%', sqlerrm); end;
  pv := public.preview_group(code);
  perform t_result('preview shows group name and the 2 unclaimed names', pv->>'name'='Goa trip' and jsonb_array_length(pv->'free')=2 and (pv->>'already_member')::boolean=false, pv::text);
  perform t_result('preview of a wrong code is null', public.preview_group('nope') is null);
  perform t_result('B claims "Ravi" and joins', public.join_group(code, r, null)=gid);
  perform t_result('after joining B sees the group and 3 members', (select count(*) from groups)=1 and (select count(*) from members)=3);
  perform t_result('joining twice is harmless', public.join_group(code, null, 'Whoever')=gid);
  reset role;
end $$;

-- 4. B (now a member) tries to cheat
do $$ declare gid uuid:=(select v::uuid from test_ctx where k='gid'); a uuid:=(select v::uuid from test_ctx where k='a');
  m uuid:=(select v::uuid from test_ctx where k='m'); eid uuid:=(select v::uuid from test_ctx where k='eid'); n int; begin
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',true);
  set local role authenticated;
  begin update members set user_id='00000000-0000-0000-0000-00000000000b' where id=m; perform t_result('cannot link own account to another name by update', false);
  exception when others then perform t_result('cannot link own account to another name by update', sqlstate='42501', sqlerrm); end;
  begin update groups set created_by='00000000-0000-0000-0000-00000000000b' where id=gid; perform t_result('cannot take over group ownership', false);
  exception when others then perform t_result('cannot take over group ownership', sqlstate='42501', sqlerrm); end;
  begin update groups set invite_code='hacked' where id=gid; perform t_result('cannot set invite code directly', false);
  exception when others then perform t_result('cannot set invite code directly', sqlstate='42501', sqlerrm); end;
  update groups set name='Goa 2026', currency='$' where id=gid; get diagnostics n = row_count;
  perform t_result('members can rename the group and change currency', n=1);
  begin insert into expenses(group_id,description,amount_minor,paid_by,split_type) values (gid,'Direct',100,a,'equal'); perform t_result('no direct expense inserts', false);
  exception when others then perform t_result('no direct expense inserts', sqlstate='42501', sqlerrm); end;
  begin insert into expense_splits(expense_id,group_id,member_id,amount_minor) values (eid,gid,a,1); perform t_result('no direct split inserts', false);
  exception when others then perform t_result('no direct split inserts', sqlstate='42501', sqlerrm); end;
  begin update expense_splits set amount_minor=1 where expense_id=eid; perform t_result('no direct split updates', false);
  exception when others then perform t_result('no direct split updates', sqlstate='42501', sqlerrm); end;
  delete from groups where id=gid; get diagnostics n = row_count;
  perform t_result('non-creator cannot delete the group', n=0, n::text);
  delete from members where user_id is not null; get diagnostics n = row_count;
  perform t_result('claimed members cannot be deleted', n=0, n::text);
  reset role;
end $$;

-- 5. C: name clashes, other group, cross-group tricks
do $$ declare gid uuid:=(select v::uuid from test_ctx where k='gid'); code text:=(select v from test_ctx where k='code');
  m uuid:=(select v::uuid from test_ctx where k='m'); r uuid:=(select v::uuid from test_ctx where k='r'); a uuid:=(select v::uuid from test_ctx where k='a');
  g2 uuid; c2 uuid; eid uuid:=(select v::uuid from test_ctx where k='eid'); begin
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',true);
  set local role authenticated;
  begin perform public.join_group(code, r, null); perform t_result('cannot claim a name already taken', false);
  exception when others then perform t_result('cannot claim a name already taken', sqlerrm like 'Someone else already took%', sqlerrm); end;
  begin perform public.join_group(code, null, 'ASHA'); perform t_result('new name clashing with an existing one is rejected', false);
  exception when others then perform t_result('new name clashing with an existing one is rejected', sqlerrm like 'Someone in the group already uses%', sqlerrm); end;
  g2 := public.create_group('Flat','₹','Chandra',array['Zed']);
  c2 := (select id from members where group_id=g2 and name='Chandra');
  insert into test_ctx values ('g2',g2::text),('c2',c2::text);
  begin perform public.save_expense(null,g2,'Cross',100,a,current_date,'equal', jsonb_build_array(jsonb_build_object('member_id',c2,'amount_minor',100)));
    perform t_result('paid_by from another group is rejected', false);
  exception when others then perform t_result('paid_by from another group is rejected', sqlerrm like 'The person who paid is not in this group%', sqlerrm); end;
  begin perform public.save_expense(null,g2,'Cross2',100,c2,current_date,'equal', jsonb_build_array(jsonb_build_object('member_id',a,'amount_minor',100)));
    perform t_result('split member from another group is rejected', false);
  exception when others then perform t_result('split member from another group is rejected', sqlerrm like 'Someone in the split is not in this group%', sqlerrm); end;
  begin perform public.save_expense(eid,g2,'Hijack',100,c2,current_date,'equal', jsonb_build_array(jsonb_build_object('member_id',c2,'amount_minor',100)));
    perform t_result('cannot edit another group''s expense through your own group', false);
  exception when others then perform t_result('cannot edit another group''s expense through your own group', sqlerrm like 'That expense no longer exists%', sqlerrm); end;
  begin perform public.join_group(code, c2, null); perform t_result('cannot claim a member of a different group', false);
  exception when others then perform t_result('cannot claim a member of a different group', sqlerrm like 'Someone else already took%', sqlerrm); end;
  perform t_result('C sees only own group', (select count(*) from groups)=1 and (select count(*) from expenses)=0);
  reset role;
end $$;

-- 6. payments, placeholders, invite rotation
do $$ declare gid uuid:=(select v::uuid from test_ctx where k='gid'); a uuid:=(select v::uuid from test_ctx where k='a');
  r uuid:=(select v::uuid from test_ctx where k='r'); m uuid:=(select v::uuid from test_ctx where k='m'); g2 uuid:=(select v::uuid from test_ctx where k='g2');
  c2 uuid:=(select v::uuid from test_ctx where k='c2'); code text:=(select v from test_ctx where k='code'); n int; pid uuid; newc text; tmp uuid; begin
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',true);
  set local role authenticated;
  insert into payments(group_id,from_member,to_member,amount_minor) values (gid,r,a,5000) returning id into pid;
  perform t_result('member records a payment', pid is not null);
  begin insert into payments(group_id,from_member,to_member,amount_minor) values (gid,a,a,100); perform t_result('payment to self rejected', false);
  exception when others then perform t_result('payment to self rejected', sqlstate='23514', sqlerrm); end;
  begin insert into payments(group_id,from_member,to_member,amount_minor) values (gid,a,c2,100); set constraints all immediate; perform t_result('payment to another group''s person rejected', false);
  exception when others then perform t_result('payment to another group''s person rejected', sqlstate='23503', sqlerrm); end;
  begin insert into payments(group_id,from_member,to_member,amount_minor) values (gid,a,r,0); perform t_result('zero payment rejected', false);
  exception when others then perform t_result('zero payment rejected', sqlstate='23514', sqlerrm); end;
  delete from payments where id=pid; get diagnostics n = row_count; perform t_result('member can delete a payment', n=1);
  insert into members(group_id,name) values (gid,'Busy') returning id into tmp;
  perform public.save_expense(null,gid,'Busy owes',500,a,current_date,'equal', jsonb_build_array(jsonb_build_object('member_id',tmp,'amount_minor',500)));
  begin delete from members where id=tmp; set constraints all immediate; perform t_result('person in an expense cannot be removed', false);
  exception when others then perform t_result('person in an expense cannot be removed', sqlstate='23503', sqlerrm); end;
  insert into payments(group_id,from_member,to_member,amount_minor) values (gid,m,a,1) returning id into pid;
  begin delete from members where id=m; set constraints all immediate; perform t_result('person in a payment cannot be removed', false);
  exception when others then perform t_result('person in a payment cannot be removed', sqlstate='23503', sqlerrm); end;
  delete from payments where id=pid;
  insert into members(group_id,name) values (gid,'Temp') returning id into tmp;
  delete from members where id=tmp; get diagnostics n = row_count; perform t_result('unused placeholder can be removed', n=1);
  begin insert into members(group_id,name) values (gid,'MEENA'); perform t_result('duplicate name (any case) rejected', false);
  exception when others then perform t_result('duplicate name (any case) rejected', sqlstate='23505', sqlerrm); end;
  newc := public.rotate_invite_code(gid);
  perform t_result('rotating the code changes it', newc <> code and (select invite_code from groups where id=gid)=newc);
  perform t_result('old code stops working', public.preview_group(code) is null);
  insert into test_ctx values ('newcode',newc);
  reset role;
end $$;

-- 7. anon (not signed in)
do $$ declare gid uuid:=(select v::uuid from test_ctx where k='gid'); begin
  set local role anon;
  begin perform count(*) from groups; perform t_result('anon cannot read groups', false);
  exception when others then perform t_result('anon cannot read groups', sqlstate='42501', sqlerrm); end;
  begin perform public.preview_group('x'); perform t_result('anon cannot call preview_group', false);
  exception when others then perform t_result('anon cannot call preview_group', sqlstate='42501', sqlerrm); end;
  begin perform public.create_group('x','x','x',array[]::text[]); perform t_result('anon cannot call create_group', false);
  exception when others then perform t_result('anon cannot call create_group', sqlstate='42501', sqlerrm); end;
  reset role;
end $$;

-- 8. member deletes an expense; creator deletes the group and everything goes
do $$ declare gid uuid:=(select v::uuid from test_ctx where k='gid'); eid uuid:=(select v::uuid from test_ctx where k='eid'); n int; begin
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',true);
  set local role authenticated;
  delete from expenses where id=eid; get diagnostics n = row_count;
  perform t_result('another member can delete an expense', n=1);
  reset role;
  perform t_result('its splits went with it', (select count(*) from expense_splits where expense_id=eid)=0);
end $$;
do $$ declare gid uuid:=(select v::uuid from test_ctx where k='gid'); a uuid:=(select v::uuid from test_ctx where k='a');
  r uuid:=(select v::uuid from test_ctx where k='r'); m uuid:=(select v::uuid from test_ctx where k='m'); n int; begin
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',true);
  set local role authenticated;
  perform public.save_expense(null,gid,'Again',900,a,current_date,'equal', jsonb_build_array(jsonb_build_object('member_id',a,'amount_minor',300),jsonb_build_object('member_id',r,'amount_minor',300),jsonb_build_object('member_id',m,'amount_minor',300)));
  insert into payments(group_id,from_member,to_member,amount_minor) values (gid,r,a,100);
  delete from groups where id=gid; get diagnostics n = row_count;
  perform t_result('creator can delete the group (members, expenses, payments cascade)', n=1);
  reset role;
  perform t_result('nothing left behind', (select count(*) from members where group_id=gid)+(select count(*) from expenses where group_id=gid)+(select count(*) from expense_splits where group_id=gid)+(select count(*) from payments where group_id=gid)=0);
end $$;
