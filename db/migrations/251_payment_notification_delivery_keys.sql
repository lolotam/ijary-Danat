-- 251_payment_notification_delivery_keys.sql
--
-- يمنع تكرار إشعار الدفع للإدارة وإيصال المستأجر لنفس الدفعات.
--
-- The race: after a MyFatoorah payment, the webhook and the tenant's
-- return-page check (`confirmGatewayPayment`) both run `settleGatewayPayment`
-- at the same moment, and both then call `notifyPaymentSuccess` for the same
-- payments. The webhook's own event claim covers the webhook's event id only —
-- the return page settles under a different one (`inquiry:<key>`) — so nothing
-- stopped the second settlement from producing a second notification.
--
-- The evidence: PREQ-0000089 on 2026-10-25 — two admin "payment received"
-- emails 68 ms apart, and the tenant's receipt twice (email and WhatsApp).
-- 11 of the 79 payments in the last 30 days were notified twice.
--
-- The fix copies the contract_expiry index from migration 34: the same partial
-- unique index on `notifications(delivery_key)`, widened to the two payment
-- notification types. `enqueueNotification` already reads a 23505 on insert as
-- "this delivery already exists" and returns the existing row instead of
-- sending again, so the DATABASE — not the application — decides that one
-- payment set produces one notification per channel.
--
-- كل حالة يمكن أن تبدأ منها إعادة المحاولة داخل الفهرس: `queued` و`sent`
-- و`failed` و`needs_review` و`skipped` — صف واحد لكل مفتاح تسليم في كل
-- الحالات التي قد تُشحن لاحقاً، فتستعمل إعادة المحاولة الصف نفسه بدل أن
-- يُنشأ صف ثانٍ لنفس المفتاح.
--
-- `skipped` داخل الفهرس أيضاً: صف إشعار مستأجر موقوف قد يُشحن بعد رفع
-- الإيقاف، فإبقاؤه خارج الفهرس يسمح بصفين `skipped` بنفس المفتاح عند
-- تسويتين متسابقتين، ثم يصطدم تحديث أحدهما إلى `sent` بالآخر فيبقى
-- `skipped` ويُعاد إرساله. أما `cancelled` وحدها فتبقى خارج الفهرس:
-- سُحبت عمداً، فلا يجوز لها أن تمنع تسليماً حقيقياً.
--
-- Every state that can still be dispatched is inside the index: `queued`,
-- `sent`, `failed`, `needs_review` and `skipped`. One row per delivery key
-- across every one of them is the point — were `failed` outside it, a second
-- settlement would insert a FRESH row with the same key, and the drain job's
-- later update of the failed row to `sent` would collide with that fresh row,
-- stay `failed`, and be resent on every drain.
--
-- `skipped` is inside it too: a paused tenant's row is still dispatchable
-- once the tenant is unpaused, so leaving `skipped` outside lets two racing
-- settlements insert two `skipped` rows with the same key — and the first
-- row's later update to `sent` then collides with the second, stays
-- `skipped`, and the tenant's receipt goes out twice. Only `cancelled`
-- stays outside: it was withdrawn on purpose, so it must never block a real
-- delivery.
--
-- Index only: no data is touched. Existing rows carry `delivery_key` null and
-- are therefore outside the index.
--
-- Rollback: drop the index —
--   drop index if exists public.notifications_payment_delivery_idx;

create unique index if not exists notifications_payment_delivery_idx
  on public.notifications(delivery_key)
  where type in ('payment_admin_alert', 'receipt')
    and state in ('queued', 'sent', 'failed', 'needs_review', 'skipped')
    and delivery_key is not null;
