-- Split Ledger: tables, security rules and functions for Supabase.
--
-- How to run: Supabase dashboard > SQL Editor > New query > paste this whole file > Run.
-- Run it once on a NEW, separate Supabase project (not the DSR project).
--
-- Design notes
--  * Money is stored as whole minor units (paise/cents) in bigint, so totals never drift.
--  * Every table is protected by row-level security: you only see groups you belong to.
--  * Expenses and their splits are written only through save_expense(), which checks that
--    the split adds up to the expense amount, so a client can never store a broken split.
--  * People can be added to a group before they have an account ("placeholder" members).
--    When they open an invite link they claim their name, and their account is linked to it.

-- ---------------------------------------------------------------- tables
--
-- The links from expenses/splits/payments to members are "deferrable initially deferred": they are
-- checked when the whole request finishes. That lets deleting a group remove its people and its
-- expenses together, while removing one person who is still in an expense is still refused.

create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(trim(name)) between 1 and 60),
  currency    text not null default '₹' check (char_length(currency) between 1 and 4),
  invite_code text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 10),
  created_by  uuid not null default auth.uid() references auth.users (id),
  created_at  timestamptz not null default now()
);

create table public.members (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups (id) on delete cascade,
  user_id    uuid references auth.users (id) on delete set null,
  name       text not null check (char_length(trim(name)) between 1 and 40),
  created_at timestamptz not null default now(),
  unique (id, group_id)
);
create unique index members_one_account_per_group on public.members (group_id, user_id) where user_id is not null;
create unique index members_unique_name_per_group  on public.members (group_id, lower(name));
create index members_user_idx on public.members (user_id);

create table public.expenses (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.groups (id) on delete cascade,
  description  text not null check (char_length(trim(description)) between 1 and 80),
  amount_minor bigint not null check (amount_minor > 0),
  paid_by      uuid not null,
  expense_date date not null default current_date,
  split_type   text not null check (split_type in ('equal', 'exact', 'percent', 'shares')),
  created_by   uuid not null default auth.uid() references auth.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, group_id),
  foreign key (paid_by, group_id) references public.members (id, group_id) deferrable initially deferred
);
create index expenses_group_idx on public.expenses (group_id, expense_date desc);

create table public.expense_splits (
  expense_id   uuid not null,
  group_id     uuid not null,
  member_id    uuid not null,
  amount_minor bigint not null check (amount_minor >= 0),
  input_value  numeric not null default 1,   -- what was typed: exact (minor units), percent, or shares
  primary key (expense_id, member_id),
  foreign key (expense_id, group_id) references public.expenses (id, group_id) on delete cascade,
  foreign key (member_id, group_id)  references public.members  (id, group_id) deferrable initially deferred
);
create index expense_splits_group_idx on public.expense_splits (group_id);

create table public.payments (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.groups (id) on delete cascade,
  from_member  uuid not null,
  to_member    uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  payment_date date not null default current_date,
  created_by   uuid not null default auth.uid() references auth.users (id),
  created_at   timestamptz not null default now(),
  check (from_member <> to_member),
  foreign key (from_member, group_id) references public.members (id, group_id) deferrable initially deferred,
  foreign key (to_member,   group_id) references public.members (id, group_id) deferrable initially deferred
);
create index payments_group_idx on public.payments (group_id);

-- ---------------------------------------------------------------- helper

create or replace function public.is_group_member(gid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.members m where m.group_id = gid and m.user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------- privileges
-- Start from nothing, then grant only what the app needs.

revoke all on public.groups, public.members, public.expenses, public.expense_splits, public.payments
  from anon, authenticated;

grant select on public.groups, public.members, public.expenses, public.expense_splits, public.payments to authenticated;
grant update (name, currency)                          on public.groups   to authenticated;
grant delete                                           on public.groups   to authenticated;
grant insert (group_id, name)                          on public.members  to authenticated;
grant update (name)                                    on public.members  to authenticated;
grant delete                                           on public.members  to authenticated;
grant delete                                           on public.expenses to authenticated;
grant insert (group_id, from_member, to_member, amount_minor, payment_date) on public.payments to authenticated;
grant delete                                           on public.payments to authenticated;

-- ---------------------------------------------------------------- row-level security

alter table public.groups         enable row level security;
alter table public.members        enable row level security;
alter table public.expenses       enable row level security;
alter table public.expense_splits enable row level security;
alter table public.payments       enable row level security;

create policy groups_select on public.groups for select to authenticated
  using (public.is_group_member(id));
create policy groups_update on public.groups for update to authenticated
  using (public.is_group_member(id)) with check (public.is_group_member(id));
create policy groups_delete on public.groups for delete to authenticated
  using (created_by = auth.uid());

create policy members_select on public.members for select to authenticated
  using (public.is_group_member(group_id));
create policy members_insert on public.members for insert to authenticated
  with check (public.is_group_member(group_id) and user_id is null);
create policy members_update on public.members for update to authenticated
  using (public.is_group_member(group_id)) with check (public.is_group_member(group_id));
create policy members_delete on public.members for delete to authenticated
  using (public.is_group_member(group_id) and user_id is null);

create policy expenses_select on public.expenses for select to authenticated
  using (public.is_group_member(group_id));
create policy expenses_delete on public.expenses for delete to authenticated
  using (public.is_group_member(group_id));

create policy splits_select on public.expense_splits for select to authenticated
  using (public.is_group_member(group_id));

create policy payments_select on public.payments for select to authenticated
  using (public.is_group_member(group_id));
create policy payments_insert on public.payments for insert to authenticated
  with check (public.is_group_member(group_id));
create policy payments_delete on public.payments for delete to authenticated
  using (public.is_group_member(group_id));

-- ---------------------------------------------------------------- functions the app calls

-- Create a group, add yourself, and add the other people by name. All in one step.
create or replace function public.create_group(p_name text, p_currency text, p_my_name text, p_others text[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  gid uuid;
  v   text;
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the group a name.'; end if;
  if coalesce(trim(p_my_name), '') = '' then raise exception 'Enter your name.'; end if;

  insert into public.groups (name, currency, created_by)
  values (trim(p_name), coalesce(nullif(trim(p_currency), ''), '₹'), uid)
  returning id into gid;

  insert into public.members (group_id, user_id, name) values (gid, uid, trim(p_my_name));

  foreach v in array coalesce(p_others, '{}'::text[]) loop
    v := trim(v);
    if v <> '' and not exists (select 1 from public.members where group_id = gid and lower(name) = lower(v)) then
      insert into public.members (group_id, name) values (gid, v);
    end if;
  end loop;

  return gid;
end;
$$;

-- Look up a group by invite code so a new person can pick which name is theirs.
create or replace function public.preview_group(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.groups;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select * into g from public.groups where invite_code = lower(trim(p_code));
  if not found then return null; end if;
  return jsonb_build_object(
    'group_id', g.id,
    'name', g.name,
    'already_member', exists (select 1 from public.members where group_id = g.id and user_id = auth.uid()),
    'free', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) order by m.name)
      from public.members m where m.group_id = g.id and m.user_id is null
    ), '[]'::jsonb)
  );
end;
$$;

-- Join with an invite code: claim a name that was added for you, or join as a new person.
create or replace function public.join_group(p_code text, p_member uuid default null, p_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  g   public.groups;
  mid uuid;
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  select * into g from public.groups where invite_code = lower(trim(p_code));
  if not found then raise exception 'That invite code does not match any group.'; end if;

  if exists (select 1 from public.members where group_id = g.id and user_id = uid) then
    return g.id;
  end if;

  if p_member is not null then
    update public.members set user_id = uid
     where id = p_member and group_id = g.id and user_id is null
    returning id into mid;
    if mid is null then raise exception 'Someone else already took that name.'; end if;
  else
    if coalesce(trim(p_name), '') = '' then raise exception 'Enter your name.'; end if;
    begin
      insert into public.members (group_id, user_id, name) values (g.id, uid, trim(p_name));
    exception when unique_violation then
      raise exception 'Someone in the group already uses that name. Pick it from the list or use a different name.';
    end;
  end if;

  return g.id;
end;
$$;

-- Replace the invite code (old links stop working).
create or replace function public.rotate_invite_code(p_group uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
begin
  if not public.is_group_member(p_group) then raise exception 'You are not in this group.'; end if;
  update public.groups set invite_code = c where id = p_group;
  return c;
end;
$$;

-- Add a new expense (p_id null) or replace an existing one, together with its split.
-- p_splits: [{ "member_id": "...", "amount_minor": 1234, "input_value": 1 }, ...]
create or replace function public.save_expense(
  p_id uuid, p_group uuid, p_desc text, p_amount bigint, p_paid_by uuid,
  p_date date, p_type text, p_splits jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  eid   uuid;
  total bigint;
  cnt   int;
  dcnt  int;
begin
  if not public.is_group_member(p_group) then raise exception 'You are not in this group.'; end if;
  if coalesce(trim(p_desc), '') = '' then raise exception 'Say what the expense was for.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above zero.'; end if;
  if p_type not in ('equal', 'exact', 'percent', 'shares') then raise exception 'Unknown split type.'; end if;
  if p_splits is null or jsonb_typeof(p_splits) <> 'array' or jsonb_array_length(p_splits) = 0 then
    raise exception 'Choose at least one person to split with.';
  end if;

  select coalesce(sum((s->>'amount_minor')::bigint), 0), count(*), count(distinct s->>'member_id')
    into total, cnt, dcnt
    from jsonb_array_elements(p_splits) s;

  if dcnt <> cnt then raise exception 'A person appears twice in the split.'; end if;
  if exists (select 1 from jsonb_array_elements(p_splits) s where (s->>'amount_minor')::bigint < 0) then
    raise exception 'A share cannot be negative.';
  end if;
  if total <> p_amount then
    raise exception 'The split adds up to % but the expense is %.', total, p_amount;
  end if;
  if not exists (select 1 from public.members m where m.id = p_paid_by and m.group_id = p_group) then
    raise exception 'The person who paid is not in this group.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_splits) s
    where not exists (select 1 from public.members m where m.id = (s->>'member_id')::uuid and m.group_id = p_group)
  ) then
    raise exception 'Someone in the split is not in this group.';
  end if;

  if p_id is null then
    insert into public.expenses (group_id, description, amount_minor, paid_by, expense_date, split_type, created_by)
    values (p_group, trim(p_desc), p_amount, p_paid_by, p_date, p_type, auth.uid())
    returning id into eid;
  else
    update public.expenses
       set description = trim(p_desc), amount_minor = p_amount, paid_by = p_paid_by,
           expense_date = p_date, split_type = p_type, updated_at = now()
     where id = p_id and group_id = p_group
    returning id into eid;
    if eid is null then raise exception 'That expense no longer exists.'; end if;
    delete from public.expense_splits where expense_id = eid;
  end if;

  insert into public.expense_splits (expense_id, group_id, member_id, amount_minor, input_value)
  select eid, p_group, (s->>'member_id')::uuid, (s->>'amount_minor')::bigint, coalesce((s->>'input_value')::numeric, 1)
    from jsonb_array_elements(p_splits) s;

  return eid;
end;
$$;

-- Only signed-in people may call the functions; nobody else gets them.
revoke all on function public.create_group(text, text, text, text[])            from public, anon;
revoke all on function public.preview_group(text)                               from public, anon;
revoke all on function public.join_group(text, uuid, text)                      from public, anon;
revoke all on function public.rotate_invite_code(uuid)                          from public, anon;
revoke all on function public.save_expense(uuid, uuid, text, bigint, uuid, date, text, jsonb) from public, anon;
revoke all on function public.is_group_member(uuid)                             from public, anon;
grant execute on function public.create_group(text, text, text, text[])            to authenticated;
grant execute on function public.preview_group(text)                               to authenticated;
grant execute on function public.join_group(text, uuid, text)                      to authenticated;
grant execute on function public.rotate_invite_code(uuid)                          to authenticated;
grant execute on function public.save_expense(uuid, uuid, text, bigint, uuid, date, text, jsonb) to authenticated;
grant execute on function public.is_group_member(uuid)                             to authenticated;

-- ---------------------------------------------------------------- live updates

alter table public.groups         replica identity full;
alter table public.members        replica identity full;
alter table public.expenses       replica identity full;
alter table public.expense_splits replica identity full;
alter table public.payments       replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.groups, public.members, public.expenses, public.expense_splits, public.payments;
  end if;
end $$;
