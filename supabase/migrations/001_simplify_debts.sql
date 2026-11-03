-- Run once in the Supabase SQL Editor on an existing project.
-- Adds the shared "Simplify debts" switch for each group (on by default).
alter table public.groups add column if not exists simplify_debts boolean not null default true;
