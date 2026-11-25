-- 126_card_visibility.sql
-- تحكّم على مستوى الشركة في إظهار وإخفاء بطاقات المؤشرات أعلى صفحات القوائم.
--
-- Absence of a row means the card is visible. Only hidden cards are stored, so
-- adding a card to the registry needs no data migration and a card can never be
-- hidden by accident because someone forgot to seed it.

create table if not exists public.card_visibility (
  company_id uuid not null references public.companies(id) on delete cascade,
  card_id text not null,
  is_visible boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (company_id, card_id)
);

alter table public.card_visibility enable row level security;

-- Supabase grants ALL on a new public table to anon and authenticated, and
-- `revoke ... from public` reaches neither of them — they hold their own grants.
revoke all on public.card_visibility from public;
revoke all on public.card_visibility from anon;
revoke all on public.card_visibility from authenticated;
grant select, insert, update, delete on public.card_visibility to authenticated;
grant select, insert, update, delete on public.card_visibility to service_role;

-- Scoped to the reader's own company rather than `using (true)`.
--
-- Most staff tables in this schema carry company_id and do NOT filter on it,
-- which is survivable only while one company exists. Here it is not merely a
-- disclosure question: the client keys visibility by card_id alone, so an
-- unscoped read would let a second company's hidden cards blank out this
-- company's pages. Getting it right on a new table costs one join.
drop policy if exists card_visibility_select on public.card_visibility;
create policy card_visibility_select on public.card_visibility
  for select to authenticated
  using (
    company_id = (select p.company_id from public.profiles p where p.id = auth.uid())
  );

drop policy if exists card_visibility_write on public.card_visibility;
create policy card_visibility_write on public.card_visibility
  for all to authenticated
  using (
    public.has_permission(auth.uid(), 'company.update')
    and company_id = (select p.company_id from public.profiles p where p.id = auth.uid())
  )
  with check (
    public.has_permission(auth.uid(), 'company.update')
    and company_id = (select p.company_id from public.profiles p where p.id = auth.uid())
  );

drop trigger if exists set_updated_at on public.card_visibility;
create trigger set_updated_at before update on public.card_visibility
  for each row execute function public.tg_set_updated_at();
