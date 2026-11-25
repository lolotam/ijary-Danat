-- 240_investor_wording_templates.sql
--
-- The owner renamed the counter-party on invoices and receipts from المستأجر
-- (Tenant) to المستثمر (Investor). Code-built copy changes in the same PR; this
-- updates the admin-editable DB rows in place (never re-seeds — they may have
-- been edited since migrations 70/93). Idempotent: a second run matches nothing.
update public.notification_templates
   set subject_ar = replace(subject_ar, 'المستأجر', 'المستثمر'),
       body_ar    = replace(body_ar,    'المستأجر', 'المستثمر'),
       subject_en = replace(replace(subject_en, 'Tenant:', 'Investor:'), '>Tenant<', '>Investor<'),
       body_en    = replace(replace(body_en,    'Tenant:', 'Investor:'), '>Tenant<', '>Investor<'),
       updated_at = now()
 where code in ('invoice-document', 'invoice-disputed', 'invoice-written-off')
   and (   (coalesce(subject_ar,'') || coalesce(body_ar,'')) like '%المستأجر%'
        or (coalesce(subject_en,'') || coalesce(body_en,'')) ~ '(Tenant:|>Tenant<)');
