-- 125 — drop the template locale split (phase 2 of 2)
--
-- Run ONLY after the new container is confirmed serving. Between 124 and this
-- migration both codes resolve, which is what makes the container swap safe.
--
-- Keyed on the explicit legacy list, never a regex: an admin-created
-- `lease-renewal-ar` is legitimate and must survive.

begin;

create temporary table legacy_stem(stem text primary key) on commit drop;
insert into legacy_stem(stem) values
  ('due-reminder'), ('overdue-reminder'), ('receipt'), ('contract-expiry'),
  ('invoice-document'), ('deposit-confirmation'), ('user-credentials'),
  ('payment-admin-alert'), ('contact-inquiry'), ('maintenance-request'),
  ('refund-recorded'), ('contract-created'), ('contract-ended'),
  ('contract-closeout'), ('contract-restored'), ('invoice-written-off'),
  ('invoice-disputed');

-- The FK only protects legacy codes that notifications actually reference. A
-- stem with no history would otherwise be deleted even if 124 never created its
-- alias — and every future automatic send under that stem would fail its FK.
do $$
declare
  missing text;
begin
  select string_agg(s.stem, ', ') into missing
    from legacy_stem s
   where not exists (
     select 1 from public.notification_templates t where t.code = s.stem
   );
  if missing is not null then
    raise exception 'Migration 124 did not create aliases for: %', missing;
  end if;
end $$;

update public.notifications n
   set template_code = s.stem
  from legacy_stem s
 where n.template_code in (s.stem || '-ar', s.stem || '-en');

delete from public.notification_templates t
 using legacy_stem s
 where t.code in (s.stem || '-ar', s.stem || '-en');

alter table public.notification_templates drop column if exists locale;

commit;
