-- ---------------------------------------------------------------------------
-- 73 — restore the placeholders migration 70 dropped from contract-expiry
-- ---------------------------------------------------------------------------
--
-- Migration 58 set these two bodies deliberately. Their text is the source for
-- BOTH legs of contract expiry: the email, and — via stripMarkup — the WhatsApp
-- message. It carried {{unit}}, {{days_until}} and {{company_name}}, and 58 also
-- seeded provider_param_keys = ['tenant_name','unit','days_until','company_name']
-- so the WhatsApp Business template mapping matched what the body said.
--
-- Migration 70 ported every body from its email builder and overwrote these two
-- with the builder's three placeholders — {{tenant_name}}, {{contract_code}},
-- {{end_date}} — silently dropping the other three. Two things broke:
--
--   1. The body stopped agreeing with its own provider_param_keys.
--   2. The WhatsApp text lost the unit and the days remaining, which is the
--      whole point of an expiry reminder. "Your contract CTR-1 ends on
--      2026-12-31" does not tell a tenant it is nine days away.
--
-- 70 is already applied, so this re-issues the bodies rather than editing it.
-- The union of both sets is used: the email gains the unit, the day count and
-- the company name, and the WhatsApp text gets them back.
--
-- expiryBuckets.sqltest.ts asserts {{days_until}} survives here. It is the test
-- that caught this, and it stays exactly as strict as it was.

update public.notification_templates
set
  subject_ar = 'تنبيه انتهاء العقد {{contract_code}}',
  subject_en = 'Contract {{contract_code}} expiry notice',
  body_ar = $ar$
<p>مرحباً {{tenant_name}}،</p>
<p>ينتهي عقدك رقم <strong>{{contract_code}}</strong> للوحدة <strong>{{unit}}</strong> خلال <strong>{{days_until}}</strong> يوم، بتاريخ <strong>{{end_date}}</strong>.</p>
<p>يرجى التواصل معنا لمناقشة التجديد أو الإخلاء.</p>
<p>{{company_name}}</p>
$ar$,
  body_en = $en$
<p>Hello {{tenant_name}},</p>
<p>Your contract <strong>{{contract_code}}</strong> for unit <strong>{{unit}}</strong> ends in <strong>{{days_until}}</strong> day(s), on <strong>{{end_date}}</strong>.</p>
<p>Please contact us to arrange renewal or handover.</p>
<p>{{company_name}}</p>
$en$
where code in ('contract-expiry-ar', 'contract-expiry-en');
