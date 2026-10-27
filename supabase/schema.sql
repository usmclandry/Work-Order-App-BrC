-- Run this once in the Supabase SQL editor after creating a free project.
-- Then add each person under Authentication → Users. The app allows 10.
-- Turn off "Allow new users to sign up" so nobody else can open the data.

create table if not exists public.app_state (
  id int primary key default 1 check (id = 1),
  settings jsonb not null,
  equipment jsonb not null,
  work jsonb not null,
  revision bigint not null default 1
);

insert into public.app_state (id, settings, equipment, work)
values (
  1,
  '{"version":1,"people":[]}'::jsonb,
  '{"version":1,"equipment":[]}'::jsonb,
  '{"version":1,"orders":[],"attachments":[]}'::jsonb
)
on conflict (id) do nothing;

alter table public.app_state enable row level security;

grant select, update on public.app_state to authenticated;

drop policy if exists "signed in people can read the campus" on public.app_state;
create policy "signed in people can read the campus"
  on public.app_state
  for select
  to authenticated
  using (true);

drop policy if exists "signed in people can save the campus" on public.app_state;
create policy "signed in people can save the campus"
  on public.app_state
  for update
  to authenticated
  using (true)
  with check (true);

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

drop policy if exists "signed in people can read attachments" on storage.objects;
create policy "signed in people can read attachments"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'attachments');

drop policy if exists "signed in people can upload attachments" on storage.objects;
create policy "signed in people can upload attachments"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'attachments');

drop policy if exists "signed in people can replace attachments" on storage.objects;
create policy "signed in people can replace attachments"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'attachments')
  with check (bucket_id = 'attachments');
