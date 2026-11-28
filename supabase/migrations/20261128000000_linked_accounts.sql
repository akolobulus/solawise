create table public.linked_accounts (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('pollar', 'phantom')),
  wallet_address text not null check (length(wallet_address) between 32 and 64),
  linked_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.linked_accounts enable row level security;

revoke all on table public.linked_accounts from anon, authenticated;
grant select on table public.linked_accounts to authenticated;
grant insert (user_id, provider, wallet_address)
  on table public.linked_accounts to authenticated;
grant update (user_id, provider, wallet_address)
  on table public.linked_accounts to authenticated;

create policy "Users can read their own linked accounts"
  on public.linked_accounts for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can add their own linked accounts"
  on public.linked_accounts for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own linked accounts"
  on public.linked_accounts for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
