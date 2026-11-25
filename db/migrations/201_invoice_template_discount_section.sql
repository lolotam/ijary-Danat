-- 201_invoice_template_discount_section.sql
--
-- صفّا «الإجمالي قبل الخصم» و«الخصم» في قالب نسخة الفاتورة يظهران فقط عند وجود خصم.
--
-- The stored body is admin-editable and has been edited since migration 70
-- seeded it, so this is an exact-markup wrap of the two known rows, not a
-- re-seed: everything else the admin wrote survives. `renderTemplate` renders
-- a {{#has_discount}} section only when the sender passes a non-empty value.
-- Idempotent through the position() guard, and TRANSACTIONAL: the verifying
-- do-block at the end must be able to undo a half-applied wrap.
--
-- RELEASE ORDER: apply this file only AFTER the bundle that contains the
-- section-aware renderer (PR feat/invoice-pdf-and-filters) is live. The old
-- renderer would print {{#has_discount}} literally to tenants.

begin;

update public.notification_templates
   set body_ar = replace(body_ar,
        '<tr><td style="padding:8px 12px;color:#6b6b6b;">الإجمالي قبل الخصم</td>',
        '{{#has_discount}}<tr><td style="padding:8px 12px;color:#6b6b6b;">الإجمالي قبل الخصم</td>')
 where code = 'invoice-document' and position('{{#has_discount}}' in body_ar) = 0;

update public.notification_templates
   set body_ar = replace(body_ar,
        '{{discount}}</td></tr>',
        '{{discount}}</td></tr>{{/has_discount}}')
 where code = 'invoice-document'
   and position('{{#has_discount}}' in body_ar) > 0 and position('{{/has_discount}}' in body_ar) = 0;

update public.notification_templates
   set body_en = replace(body_en,
        '<tr><td style="padding:8px 12px;color:#6b6b6b;">Subtotal</td>',
        '{{#has_discount}}<tr><td style="padding:8px 12px;color:#6b6b6b;">Subtotal</td>')
 where code = 'invoice-document' and position('{{#has_discount}}' in body_en) = 0;

update public.notification_templates
   set body_en = replace(body_en,
        '{{discount}}</td></tr>',
        '{{discount}}</td></tr>{{/has_discount}}')
 where code = 'invoice-document'
   and position('{{#has_discount}}' in body_en) > 0 and position('{{/has_discount}}' in body_en) = 0;

-- Verified, not assumed: a body whose markup drifted from the literals above
-- would leave replace() a no-op and this migration "succeeding" over an
-- unwrapped row. Exactly one opener, exactly one closer, in the right order,
-- in both locales — or abort.
do $$
declare
  v record;
begin
  for v in
    select body_ar as body, 'ar' as loc from public.notification_templates where code = 'invoice-document'
    union all
    select body_en, 'en' from public.notification_templates where code = 'invoice-document'
  loop
    if (length(v.body) - length(replace(v.body, '{{#has_discount}}', ''))) / 17 <> 1
       or (length(v.body) - length(replace(v.body, '{{/has_discount}}', ''))) / 17 <> 1
       or position('{{#has_discount}}' in v.body) > position('{{subtotal}}' in v.body)
       or position('{{discount}}' in v.body) > position('{{/has_discount}}' in v.body) then
      raise exception 'invoice-document body (%) could not be wrapped in a discount section', v.loc;
    end if;
  end loop;
end $$;

commit;
