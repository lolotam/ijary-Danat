-- 245_payment_admin_alert_method.sql
--
-- تنبيه الإدارة بالدفعة يذكر طريقة الدفع، بنفس تسمية عمود الطريقة في /admin/payments.
--
-- notifyPaymentSuccess now fills {{payment_method}}; the stored body is what is
-- sent (the built-in builder is only a fallback), so the row must carry the
-- placeholder or the new line never reaches an inbox. Inserted right after the
-- payment-codes line; a body an admin reworded without that line gets it
-- appended instead.
--
-- The line sits inside a {{#payment_method}} section, so the bundle that predates
-- this change — which never sets the variable — drops the whole line instead of
-- mailing a raw "{{payment_method}}". That keeps the usual migration-first deploy
-- order safe. A NULL body stays NULL: NULL means "use the built-in alert", and
-- appending to it would replace that full alert with a method-only one.
-- Idempotent: a body already naming the placeholder is left alone.

update public.notification_templates
set
  body_ar = case
    when body_ar is null then null
    when body_ar like '%{{payment_codes}}</p>%' then replace(
      body_ar,
      '{{payment_codes}}</p>',
      E'{{payment_codes}}</p>{{#payment_method}}\n       <p><strong>طريقة الدفع:</strong> {{payment_method}}</p>{{/payment_method}}'
    )
    else body_ar || E'{{#payment_method}}\n<p><strong>طريقة الدفع:</strong> {{payment_method}}</p>{{/payment_method}}'
  end,
  body_en = case
    when body_en is null then null
    when body_en like '%{{payment_codes}}</p>%' then replace(
      body_en,
      '{{payment_codes}}</p>',
      E'{{payment_codes}}</p>{{#payment_method}}\n       <p><strong>Payment method:</strong> {{payment_method}}</p>{{/payment_method}}'
    )
    else body_en || E'{{#payment_method}}\n<p><strong>Payment method:</strong> {{payment_method}}</p>{{/payment_method}}'
  end
where code = 'payment-admin-alert'
  and coalesce(body_ar, '') not like '%{{payment_method}}%'
  and coalesce(body_en, '') not like '%{{payment_method}}%';
