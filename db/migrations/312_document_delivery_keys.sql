-- 312_document_delivery_keys.sql
--
-- يمنع تكرار صف تسليم المستند الواحد لكل مهمة وقناة: الفاتورة، معلومات الشركة،
-- والتقرير المجدول.
--
-- The race: a document job's delivery row was decided by an application
-- read-then-insert — `findDocumentDeliveries` first, insert when the read came
-- back empty. Two workers on the same job (BullMQ hands a stalled job to a
-- second worker while the first is still inside the handler) can both pass the
-- read and both insert, so the renter is sent the same invoice, company-info
-- document or scheduled report twice.
--
-- The fix copies the delivery-key indexes as migration 273 rebuilt them per
-- company: a partial unique index on `notifications(company_id,
-- delivery_key)`, widened to exactly
-- the three notification types the document handlers write — `document_send`,
-- `company_info` and `scheduled_report`. `enqueueNotification` already reads a
-- 23505 on insert as "this delivery already exists" and returns the existing
-- row instead of sending again, and the report and company-info direct
-- inserts do the same — so the DATABASE, not the application read, decides
-- that one job produces one delivery row per channel. The three types share
-- one key space on purpose: a `<jobRequestId>:<channel>` key names one job,
-- and one job writes one type, so the application can never produce a
-- cross-type collision.
--
-- كل حالة يمكن أن تبدأ منها إعادة المحاولة داخل الفهرس: `queued` و`sent`
-- و`failed` و`needs_review` و`skipped` — صف واحد لكل مفتاح تسليم في كل
-- الحالات التي قد تُشحن لاحقاً، فتستعمل إعادة المحاولة الصف نفسه بدل أن
-- يُنشأ صف ثانٍ لنفس المفتاح. و`failed` داخل الفهرس عمداً: معه لم يعد بإمكان
-- إعادة المحاولة كتابة صف جديد بنفس المفتاح، بل تُعيد الصف الفاشل نفسه إلى
-- الطابور وتصرّفه كما تصريف مهمة التفريغ. أما `cancelled` وحدها فتبقى خارج
-- الفهرس: سُحبت عمداً، فلا يجوز لها أن تمنع تسليماً حقيقياً.
--
-- Every state that can still be dispatched is inside the index: `queued`,
-- `sent`, `failed`, `needs_review` and `skipped`. One row per delivery key
-- across every one of them is the point — were `failed` outside it, a retry
-- would insert a FRESH row with the same key while the drain job's later
-- update of the failed row to `sent` collides with that fresh row. With
-- `failed` inside, the retry instead re-queues the very row the failed
-- attempt wrote and dispatches it the way the notification drain retries a
-- failed row. Only `cancelled` stays outside: it was withdrawn on purpose, so
-- it must never block a real delivery.
--
-- Index only: no data is touched. The `delivery_key` column landed nullable
-- in migration 34 and no migration ever backfills it; the only writers of a
-- key for these three types are the document job handlers shipped alongside
-- this migration, which have never run against an existing database. Every
-- existing row of these types therefore carries `delivery_key` null, sits
-- outside the index, and the creation cannot fail on duplicate data.
--
-- Rollback: drop the index —
--   drop index if exists public.notifications_document_delivery_idx;

create unique index if not exists notifications_document_delivery_idx
  on public.notifications(company_id, delivery_key)
  where type in ('document_send', 'company_info', 'scheduled_report')
    and state in ('queued', 'sent', 'failed', 'needs_review', 'skipped')
    and delivery_key is not null;
