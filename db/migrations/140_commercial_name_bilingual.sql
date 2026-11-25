-- 140_commercial_name_bilingual.sql
--
-- `tenants.commercial_name` was a single column serving two languages.
-- `resolvePartyName` prefers it over the tenant's own name for BOTH locales
-- (src/lib/partyName.ts:23), so an Arabic commercial name printed on an English
-- invoice and vice versa. It is split in two.
--
-- The legacy column is KEPT and becomes a derived mirror rather than being
-- dropped. It is read by `bulk_import_phase6` (113:194 and :231), by the CSV
-- export and header maps, and by every row already in the table. Dropping it in
-- the same change as the split would break an import path mid-flight; a
-- compatibility trigger costs one function and removes the whole class of
-- "which callers did we miss".
--
-- "Mandatory" is enforced in the form's Zod schema only, not as NOT NULL: there
-- is no company/individual discriminator on `tenants` (`category` is a risk
-- segment — vip / uncommitted / chronically_distressed / standard / custom) and
-- most tenants are individuals with no commercial name at all. A NOT NULL would
-- need a placeholder invented for every one of them, and that placeholder would
-- then print on their invoices.

alter table public.tenants add column if not exists commercial_name_ar text;
alter table public.tenants add column if not exists commercial_name_en text;

comment on column public.tenants.commercial_name is
  'Deprecated (migration 140). Derived mirror of commercial_name_ar / _en, maintained by tg_tenant_commercial_name_compat so pre-140 readers and writers keep working. Read the bilingual columns instead.';

-- The existing value is Arabic in every row inspected before this migration,
-- and Arabic is the product's primary language — the only non-destructive
-- assumption available. English is left null and is filled the next time a
-- human edits the tenant, which the form now requires.
update public.tenants t
   set commercial_name_ar = t.commercial_name
 where t.commercial_name_ar is null
   and nullif(btrim(t.commercial_name), '') is not null;

-- ---------------------------------------------------------------------------
-- يبقي العمود القديم مرآةً للعمودين الجديدين، ويوجّه الكتابة القديمة إلى العربية.
--
-- Two directions, and the order matters:
--
--   * a writer that touched ONLY the legacy column (bulk_import_phase6, any
--     script written before this migration) has its value routed into
--     `_ar` — it cannot have meant a column that did not exist;
--   * after that, the legacy column is always recomputed from the pair, so a
--     reader that still selects `commercial_name` sees the current value
--     rather than a stale one.
--
-- A writer that sets both the legacy column and a bilingual column in the same
-- statement is taken at its word on the bilingual one: the legacy value is
-- overwritten by the mirror rather than silently winning.
-- ---------------------------------------------------------------------------
create or replace function public.tg_tenant_commercial_name_compat()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.commercial_name_ar is null
      and new.commercial_name_en is null
      and nullif(btrim(new.commercial_name), '') is not null then
      new.commercial_name_ar := btrim(new.commercial_name);
    end if;
  else
    if new.commercial_name is distinct from old.commercial_name
      and new.commercial_name_ar is not distinct from old.commercial_name_ar
      and new.commercial_name_en is not distinct from old.commercial_name_en then
      new.commercial_name_ar := nullif(btrim(new.commercial_name), '');
    end if;
  end if;

  new.commercial_name_ar := nullif(btrim(new.commercial_name_ar), '');
  new.commercial_name_en := nullif(btrim(new.commercial_name_en), '');
  new.commercial_name := coalesce(new.commercial_name_ar, new.commercial_name_en);

  return new;
end;
$$;

revoke execute on function public.tg_tenant_commercial_name_compat() from public, anon;

drop trigger if exists trg_tenant_commercial_name_compat on public.tenants;
create trigger trg_tenant_commercial_name_compat
  before insert or update on public.tenants
  for each row
  execute function public.tg_tenant_commercial_name_compat();
