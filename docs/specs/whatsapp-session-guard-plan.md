# خطة التنفيذ: حارس جلسة واتساب + إيصال واتساب كرسالة معاملات

المواصفة: [`whatsapp-session-guard.md`](./whatsapp-session-guard.md)
الفرع: `feat/whatsapp-session-guard` — **معتمدة بعد جولة النقاش الأولى** (قراراتها في المواصفة §8).

الترتيب مقصود: الجزء أ مستقل تماماً ويُنفَّذ ويُختبر أولاً (commit لوحده، بلا migration)،
ثم قاعدة البيانات، ثم السيرفر، ثم الواجهة. كل خطوة تنتهي بـ
`bun run lint && bun run typecheck && bun run test` أخضر.

قواعد سارية على كل ملف إنتاج في الخطة: تعليق عربي فوق كل دالة (والإنجليزية بعده للسبب)،
وكل ملف جديد تحت 500–600 سطر.

## 1. الجزء أ — إيصال واتساب (بلا migration)

### 1.1 تقسيم الاختبار أولاً، بلا تغيير سلوك

نقل حرفي، ثم تشغيل الاختبارات والعدد نفسه يمرّ **قبل** أي تعديل على الكود. بهذا أي فشل
بعدها سببه التعديل لا النقل.

| #   | الملف                                                      | العمل                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `src/fns/notifyPaymentSuccess.testkit.ts` (جديد)           | السطور 1–174 من الملف الحالي: الـ `vi.fn` المشتركة، البيانات المتغيّرة (`allocationData`، `invoiceData`، `contractData`) خلف كائن `state` مُصدَّر، مصانع `supabaseAdminModule()` و`paymentReceiptPdfModule()` و`enqueueNotificationModule()`، `PAYMENT_ID`، `confirmedPayment`، `storedReceiptFor`، و`resetPaymentNotifyMocks()` (جسم `beforeEach` الحالي 152–174) |
| 2   | `src/fns/notifyPaymentSuccess.test.ts`                     | يبقى فيه 176–343: مفتاح سير العمل، تصنيف النتيجة، القوالب، طريقة الدفع                                                                                                                                                                                                                                                                                             |
| 3   | `src/fns/notifyPaymentSuccess.receiptPdf.test.ts` (جديد)   | 345–569                                                                                                                                                                                                                                                                                                                                                            |
| 4   | `src/fns/notifyPaymentSuccess.recipients.test.ts` (جديد)   | 571–620                                                                                                                                                                                                                                                                                                                                                            |
| 5   | `src/fns/notifyPaymentSuccess.suppression.test.ts` (جديد)  | 622–880                                                                                                                                                                                                                                                                                                                                                            |
| 6   | `src/fns/notifyPaymentSuccess.deliveryKeys.test.ts` (جديد) | 882–998                                                                                                                                                                                                                                                                                                                                                            |

- كل ملف اختبار يكرّر ثلاثة `vi.mock` بمصنع
  `async () => (await import("./notifyPaymentSuccess.testkit")).…Module()` — نفس صيغة
  `src/fns/dispatchNotification.evolution.test.ts:3-9` — ثم
  `const { notifyPaymentSuccess } = await import("./notifyPaymentSuccess")` و
  `beforeEach(resetPaymentNotifyMocks)`.
- تحقّق: عدد الاختبارات قبل النقل = بعده (يُسجَّل الرقم من `bun run test` قبل البدء).
- بعد النقل: `test-guard` على الملفات الستة.

### 1.2 استخراج `paymentNotifyResult.ts`

| #   | الملف                                   | العمل                                                                                                                                                                                                            |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | `src/fns/paymentNotifyResult.ts` (جديد) | `PaymentNotifyResult`، `paymentsMissingPdf`، `missingPdfPayload`، `paymentNotifyOutcome` — منقولة بتعليقاتها من `notifyPaymentSuccess.ts:27-85`؛ التعليقات الإنجليزية الخالصة فوق الدوال تأخذ سطراً عربياً أولاً |
| 8   | `src/fns/notifyPaymentSuccess.ts`       | يستورد الأربعة؛ `const adminCode` و`const receiptCode` يبقيان هنا (يقرؤهما `workflowTemplates.test.ts:87-88`)                                                                                                    |

تحقّق: الاختبارات المنقولة تمرّ بلا تعديل؛ `workflowTemplates.test.ts` أخضر.

### 1.3 حذف الشرط

| #   | الملف                                              | العمل                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | `src/fns/notifyPaymentSuccess.ts`                  | رفع `const waNumber = tenant.whatsapp ?? tenant.mobile` إلى ما قبل `needsReceipt`؛ `needsReceipt` بلا `reminders_enabled`؛ شرط الإدراج `waNumber && templateAllowsChannel(receiptCopy.channel, "whatsapp")`؛ تحديث تعليق "neither an email nor reminders"؛ إضافة سطر تعليق يحيل إلى `PROACTIVE_REMINDER_TYPES` |
| 10  | `src/fns/notifyPaymentSuccess.recipients.test.ts`  | الحالات أ-1 … أ-6 من المواصفة §6                                                                                                                                                                                                                                                                               |
| 11  | `src/fns/notifyPaymentSuccess.suppression.test.ts` | الحالة أ-7                                                                                                                                                                                                                                                                                                     |
| 12  | `src/fns/notifyPaymentSuccess.receiptPdf.test.ts`  | تعليق اختبار "renders nothing when the workflow reaches no recipient" يقول "neither an email nor a WhatsApp number"؛ التأكيدات لا تتغيّر (المستأجر هناك بلا رقم)                                                                                                                                               |

تحقّق: كل حالة جديدة تُكتب وتُشاهَد **حمراء** على الكود القديم قبل تعديل البند 9، ثم خضراء بعده.
ثم `clean-code-guard` + `test-guard`.

## 2. قاعدة البيانات

### 2.1 `db/migrations/252_whatsapp_session_alert_type.sql`

```sql
alter type public.notification_types add value if not exists 'whatsapp_session_alert';
```

ملف منفصل عمداً، برأس يشرح السبب كما في `92_invoice_event_notification_types.sql`.

### 2.2 `db/migrations/253_whatsapp_session_guard.sql`

بالترتيب، وكله قابل لإعادة التطبيق:

1. `do $$ … $$`: إن لم يوجد العمود `disconnect_alert_armed` — يضيف العمودين
   (`disconnect_alert_armed boolean not null default false`، `disconnected_at timestamptz`)
   ثم يزرع `disconnect_alert_armed = coalesce(last_connection_state = 'open', false)`.
   الزرع داخل الشرط، فإعادة التطبيق لا تعيد تسليح حلقة سبق التنبيه عنها.
2. `comment on column` للعمودين.
3. `create or replace function public.tg_evolution_session_episode()` (plpgsql، بلا
   `security definer`) + `drop trigger if exists … ; create trigger
evolution_connections_session_episode before update on public.evolution_connections
for each row execute function …`. المقارنات بـ `is distinct from` (الحالة قد تكون `null`).
4. `create or replace function public.whatsapp_session_health() returns jsonb` —
   `language sql stable security definer set search_path = public, pg_temp`؛ ترجع `null`
   لغير الموظف، بصيغة `(select public.is_staff((select auth.uid())))`؛ الحقول الستة
   بتعريفات المواصفة §5.1 (`paired` من `connected_number`/`connected_at` لا من وجود الصف،
   و`settling` بـ `now()` الخادم)؛ ثم
   `revoke all on function … from public, anon;` و
   `grant execute on function … to authenticated, service_role;`.
5. `insert into public.cron_jobs (key, kind, name_ar, name_en, description_ar,
description_en, recipient_targets)` للمفتاح `whatsapp-session-disconnected`، `'event'`،
   `array['admin','company']::text[]`، بـ `on conflict (key) do update` **لا يلمس
   `is_active`** (نفس صيغة `93_invoice_event_workflows.sql`).
6. `insert into public.notification_templates (code, type, channel, subject_ar, subject_en,
body_ar, body_en)` للرمز `whatsapp-session-disconnected`، النوع `whatsapp_session_alert`،
   القناة `email`، بـ `on conflict (code) do nothing` — لا يدوس تعديل أدمن.
   تحقّق أثناء التنفيذ من أعمدة الجدول الحالية بعد 125 (لا عمود `locale`).

لا `create policy` ولا تعديل منح على `evolution_connections`: العمودان خارج منحة أعمدة
`authenticated` (`179:53-61`) عن قصد.

**التراجع** (يُكتب في رأس الملف): حذف الـ trigger ودالته، حذف `whatsapp_session_health`،
حذف صفّي `cron_jobs` و`notification_templates`، حذف العمودين. قيمة الـ enum لا تُحذف
(PostgreSQL لا يدعم ذلك) وتبقى بلا ضرر.

### 2.3 `src/db/whatsappSessionGuard.sqltest.ts` (جديد)

الحالات ب-27 … ب-36 من المواصفة §6. نمط الأدوار (`authenticated` بمطالبات JWT، `anon`) منقول من
`src/db/whatsappInbox.sqltest.ts`.

### 2.4 `src/db/workflowRegistry.sqltest.ts`

- `EVENT_KEYS`: إضافة `"whatsapp-session-disconnected"` في آخر القائمة (الترتيب أبجدي، بعد
  `user-credentials-tenant`).
- `SEEDED_RECIPIENT_TARGETS`: `"whatsapp-session-disconnected": ["admin", "company"]`.

تحقّق: `bun run test:db` (قاعدة نظيفة من الصفر) ثم `bun run test:sql`. يحتاج Docker — إن لم
يتوفّر في جلسة التنفيذ يُقال ذلك صراحة ويُشغَّل قبل الدمج.

## 3. الأنواع والسجلات الشاملة (كلها في commit واحد مع الـ migrations)

| #   | الملف                                                            | العمل                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | `src/integrations/supabase/database.types.ts` (**يدوي**)         | `NOTIFICATION_TYPES` + `"whatsapp_session_alert"`؛ `EvolutionConnectionRow` + `disconnect_alert_armed: boolean` و`disconnected_at: string \| null`؛ `Functions.whatsapp_session_health: { Args: Record<PropertyKey, never>; Returns: Json }`. `bun run gen:types` للمرجع فقط — لا يُكتب فوق الملف |
| 14  | `src/lib/notificationTypes.test.ts`                              | القائمة 21 نوعاً، وعنوان الاختبار                                                                                                                                                                                                                                                                 |
| 15  | `src/components/admin/TemplateEditorDialog.test.tsx`             | `toHaveLength(21)` وعنوان الاختبار                                                                                                                                                                                                                                                                |
| 16  | `src/lib/templateEligibility.ts` + `.test.ts`                    | `whatsapp_session_alert: { mode: "never" }` (تنبيه للموظفين فقط) + التوقّع في `:24`                                                                                                                                                                                                               |
| 17  | `src/lib/templateVariables.ts` + `.test.ts`                      | متغيرات النوع: `connected_number`، `instance_name`، `state`، `disconnected_at`، `parked_count`، `settings_url`؛ وإضافة النوع إلى قائمة "every type with a sender"                                                                                                                                 |
| 18  | `src/components/admin/notifications/NotificationPoolFilters.tsx` | إضافة النوع إلى `notificationTypes`                                                                                                                                                                                                                                                               |
| 19  | `src/i18n/locales/ar/invoices.ts` و`en/invoices.ts`              | `notificationType.whatsapp_session_alert`: "تنبيه انقطاع واتساب" / "WhatsApp session alert"                                                                                                                                                                                                       |
| 20  | `src/lib/workflowCatalog.ts`                                     | `"whatsapp-session-disconnected": { kind: "event", supportedTargets: ["admin", "company"] }`                                                                                                                                                                                                      |
| 21  | `src/lib/workflowTemplates.ts`                                   | `"whatsapp-session-disconnected": ["whatsapp-session-disconnected"]`                                                                                                                                                                                                                              |
| 22  | `src/lib/workflowTemplates.test.ts`                              | `KNOWN_TEMPLATE_CODES` + الرمز الجديد (ليس جذراً قديماً، فلا يدخل `LEGACY_TEMPLATE_STEMS`)؛ `SENDER_FILE` + `"whatsapp-session-disconnected": "src/fns/notifyWhatsappSessionDisconnected.ts"`                                                                                                     |

`bun run typecheck` هو الكاشف لأي `Record<NotificationType, …>` آخر لم يُذكر هنا؛ أي خطأ
يظهر يُصلَح في نفس الـ commit ويُضاف إلى هذا الجدول.

## 4. السيرفر

| #   | الملف                                                       | العمل                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 23  | `src/fns/notifyWhatsappSessionDisconnected.ts` (جديد، ~180) | المواصفة §4.5: النظرة الرخيصة، فحص المزوّد، `runEventWorkflow`، المطالبة، البناء بـ `renderAdminEmailCopy({ code: "whatsapp-session-disconnected", … })`، الإدراج، إرجاع المطالبة. **بلا تهدئة زمنية.** يرجّع `AdminNotificationResult` ولا يرمي. **لا ثابت باسم يحتوي `code`/`Code` قيمته نص kebab غير رمز القالب** — `TEMPLATE_SELECTION_PATTERN` يلتقطه |
| 24  | `src/fns/notifyWhatsappSessionDisconnected.test.ts` (جديد)  | الحالات ب-1 … ب-9                                                                                                                                                                                                                                                                                                                                          |
| 25  | `src/fns/evolutionSessionWatch.ts` (جديد، ~110)             | `confirmSessionDisconnect()` (المواصفة §4.4 المصدر 1: قراءة الصف، فحص المزوّد، فحص حيّ واحد، 404 من `EvolutionApiError` = انقطاع مؤكَّد)؛ `reportSendSessionDisconnected()` (المصدر 2: كتابة `close` المشروطة ثم المُرسِل). الدالتان داخل `try/catch` ولا ترفضان. **لا مؤقّت ولا حالة على مستوى الموديول**                                                 |
| 26  | `src/fns/evolutionSessionWatch.test.ts` (جديد)              | الحالات ب-10 … ب-16 — بلا مؤقتات وهمية                                                                                                                                                                                                                                                                                                                     |
| 27  | `src/fns/evolutionWebhook.ts` (323 ← ~335)                  | في `handleConnectionUpdate` بعد نجاح الكتابة: `if (state !== "open" && state !== "connecting") void confirmSessionDisconnect();` — يشمل `close` و`refused`؛ وتعليق عربي فوق الدالة (ليس لها تعليق اليوم)                                                                                                                                                   |
| 28  | `src/fns/evolutionWebhook.test.ts` (357 ← ~405)             | `vi.mock("@/fns/evolutionSessionWatch")` + الحالات ب-17 … ب-20                                                                                                                                                                                                                                                                                             |
| 29  | `src/fns/evolutionDelivery.ts` (226 ← ~245)                 | في `deliverEvolutionNotification`: `try/catch` حول `requireOpenSession` و`sendWithEvolution`؛ عند `EvolutionProviderError` بكود `session_disconnected` أو `instance_missing` ← `await reportSendSessionDisconnected()` ثم `throw error` نفسه                                                                                                               |
| 30  | `src/fns/evolutionDelivery.session.test.ts` (جديد)          | الحالات ب-21 … ب-24                                                                                                                                                                                                                                                                                                                                        |
| 31  | `src/fns/evolutionSession.ts` (258 ← ~275)                  | `disconnectEvolutionSession`: كتابة `{ disconnect_alert_armed: false, last_connection_state: "disconnecting" }` قبل `client.logout`، وترمي إن فشلت. `beginEvolutionSession` لا يُلمس، ويُضاف تعليق يشرح لماذا لا ينزع التسليح                                                                                                                              |
| 32  | `src/fns/evolutionSession.test.ts` (جديد)                   | الحالتان ب-25 و ب-26                                                                                                                                                                                                                                                                                                                                       |

ملاحظات تنفيذ:

- **دورة استيراد:** `evolutionSessionWatch` يستورد `notifyWhatsappSessionDisconnected`
  (الذي يستورد `enqueueNotification` ← `dispatchNotification` ← `dispatchWhatsAppChannel` ←
  `evolutionDelivery`)، و`evolutionDelivery` يستورد `evolutionSessionWatch`. دورة حقيقية.
  الحل: `reportSendSessionDisconnected` و`confirmSessionDisconnect` يحمّلان المُرسِل بـ
  `await import("@/fns/notifyWhatsappSessionDisconnected")` داخل الدالة. يُتحقق بـ
  `bun run build` وباختبار ب-21.
- **الفحص الحيّ في `confirmSessionDisconnect`** لا يستعمل `.catch(() => null)` كما في
  `requireOpenSession`: يحتاج التفريق بين 404 (`EvolutionApiError.status`،
  `src/lib/evolution/client.ts:29`) وأي فشل آخر.
- **`getEvolutionQrStatus`** يكتب الحالة الحيّة كل ثانيتين أثناء الحوار؛ لا يحتاج تعديلاً —
  الـ trigger يتكفّل بالتسليح عند `open`.
- **`dispatchNotification.testkit.ts`** (`:75`) يزيّف `evolution_connections`؛ اختبارات
  `dispatchNotification.evolution.test.ts:130-154` تمرّ على مسار `session_disconnected`
  وستستدعي الآن `reportSendSessionDisconnected`. تُشغَّل بعد البند 29؛ إن احتاج المزيّف
  دعم `neq`/`select` بعد `update` يُضاف هناك، أو يُزيَّف `@/fns/evolutionSessionWatch` في
  ذلك الملف.

بعد هذا القسم: `clean-code-guard` على ملفات الإنتاج، `test-guard` على ملفات الاختبار.

## 5. الواجهة

| #   | الملف                                                                 | العمل                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 33  | `src/lib/whatsappSessionBanner.ts` (جديد) + `.test.ts`                | النوع `WhatsappSessionHealth` (ستة حقول، منها `settling`)، الدالة النقية `whatsappSessionBannerState(health)` — بلا ساعة ولا `nowMs`؛ اختبار لكل سطر من جدول المواصفة §5.2                                             |
| 34  | `src/hooks/useWhatsappSessionHealth.ts` (جديد)                        | `useQuery(["whatsapp-session-health"])` على `supabase.rpc("whatsapp_session_health")`؛ `enabled` وسيط؛ `refetchInterval: 60_000`، `staleTime: 30_000`، `retry: false`؛ يتحقق من شكل الناتج (`Json`) قبل إرجاعه مطبوعاً |
| 35  | `src/components/admin/WhatsappSessionBanner.tsx` (جديد) + `.test.tsx` | المواصفة §5.3–5.4؛ الحالات ج-37 … ج-40                                                                                                                                                                                 |
| 36  | `src/routes/admin.tsx` (147 ← ~150)                                   | استيراد + `<WhatsappSessionBanner />` بين `</header>` و`<main>` — يُرسم فقط في الفرع الأخير (بعد التأكد أن المستخدم موظف)، فلا استعلام لمستأجر في طريقه إلى `/portal`                                                  |
| 37  | `src/hooks/useEvolutionConnection.ts` (167 ← ~175)                    | إبطال `["whatsapp-session-health"]` في `onSuccess` لـ `useBeginEvolutionSession` و`useDisconnectEvolutionSession`؛ وفي `useEvolutionQrStatus` عند `state === "open"`. `CONNECTION_COLUMNS` **لا يتغيّر**               |
| 38  | `src/i18n/locales/ar/admin.ts` و`en/admin.ts` (394/405)               | المفاتيح الستة `admin.whatsappBanner.*` — في الملفين معاً (`dictionary.test.ts:55` يفرض التطابق)                                                                                                                       |

تحقّق بصري (يدوي، `bun run dev`): العربية RTL والإنجليزية LTR، عرض 320px (الأزرار تلتف ولا
تطفح)، الوضع الداكن، ومستخدم بلا `settings.integrations` (نص `askAdmin` بلا رابط).
ثم `clean-code-guard` + `test-guard`.

## 6. التحقق قبل العرض

1. `bun run lint && bun run typecheck && bun run test`.
2. `bun run test:db` ثم `bun run test:sql` (Docker).
3. `bun run build` — يكشف دورة الاستيراد في §4.
4. `wc -l` على كل ملف لُمس: لا ملف جديد فوق 500، ولا ملف موجود عبر 600 بسبب هذا الفرع.
5. `docs-guard` على هذين الملفين وعلى أي تعديل في `CLAUDE.md`.
6. `graphify update .`.
7. تحديث `CLAUDE.md`: فقرة `src/fns/` تذكر `notifyWhatsappSessionDisconnected` كمُرسِل حدثي
   بترتيب مطالبة خاص؛ وقائمة ملفات الاختبار فوق 600 تُحذف منها
   `src/fns/notifyPaymentSuccess.test.ts`.
8. استعلام قراءة فقط على الإنتاج (`ssh-danatfuture-mcp`) قبل الدمج — الحالة الحالية:
   `select last_connection_state, connected_number, connected_at, updated_at from
public.evolution_connections` وعدد صفوف `session_disconnected` المعلّقة.
   (عدد المستأجرين المتأثرين بالجزء أ معروف: 2 من 59، المواصفة §2.3.)

## 7. خطوات الإنتاج (بعد الدمج — تحتاج موافقة المالك المكتوبة)

الترتيب من `CLAUDE.md`: الـ migration **قبل** أن تبدّل الحاوية. الدمج نفسه يوصل الملفين إلى
`/etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code/db/migrations`.

1. `pg_dump` أولاً (داخل `nohup sh -c '… ; echo $? > /root/status.txt' &` ثم استطلاع الملف).
2. **252 لوحده، ثم 253 لوحده** — نداءان منفصلان لـ `psql`، لا ملف واحد مدموج:
   القيمة الجديدة للـ enum يجب أن تكون committed قبل أن يستعملها 253.
   ```bash
   cd /etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code/db/migrations
   md5sum 252_whatsapp_session_alert_type.sql 253_whatsapp_session_guard.sql   # يطابق المحلي
   for f in 252_whatsapp_session_alert_type.sql 253_whatsapp_session_guard.sql; do
     docker exec -i danatfuture-supabase-ozoxsa-db-1 \
       psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - < "$f" || break
   done
   docker exec danatfuture-supabase-ozoxsa-db-1 \
     psql -U supabase_admin -d postgres -Atc "notify pgrst, 'reload schema'"
   ```
3. تحقّق بعد التطبيق:
   `select disconnect_alert_armed, last_connection_state, disconnected_at from public.evolution_connections;` — مسلَّح إن كانت `open`.
4. **توافق الـ bundle القديم مع المخطط الجديد** (الفاصل بين تطبيق الـ migration وتبديل
   الحاوية): الكود القديم لا يعرف العمودين ولا يقرؤهما؛ الـ trigger يعمل على كتاباته كما هي؛
   الدالة والصفّان الجديدان لا يستدعيهما أحد. استثناء ضيّق واحد: لو ضغط الأدمن "فصل" بالكود
   القديم خلال تلك الدقائق، يبقى `disconnect_alert_armed = true` فيُرسَل بريد واحد عند أول
   إرسال فاشل بعد التبديل.
5. بعد تبديل الحاوية: فتح `/admin` كأدمن — لا شريط والجلسة `open`. تبويب سير العمل يعرض
   "انقطاع جلسة واتساب" مفعّلاً وأهدافه الإدارة والشركة.
6. اختبار دخان اختياري بموافقة المالك (يقطع واتساب دقائق): لا يُفصل من زر الواجهة (ذلك
   مسار "بلا إنذار" عمداً) — يُفصل الجهاز من تطبيق واتساب على الهاتف، يُنتظر البريد
   (فوري بعد ويبهوك `close`) والشريط (حتى 60 ثانية — فترة استطلاعه)، ثم يُعاد المسح ويُتأكد من اختفاء الشريط.
7. الرسائل الـ 12 المعلّقة من الحادثة: تُراجَع يدوياً من
   `/admin/settings/notifications` — خارج نطاق هذا الفرع (المواصفة §7).

لا سطر crontab جديد: لا مهمة مجدولة في هذا التصميم.

## 8. ترتيب الـ commits المقترح

1. `test: split notifyPaymentSuccess tests by responsibility` (§1.1 — نقل فقط).
2. `refactor: extract payment notify result helpers` (§1.2).
3. `fix: send the WhatsApp payment receipt regardless of the reminders switch` (§1.3).
4. `feat(db): whatsapp session episode state, health rpc and alert workflow` (§2 + §3).
5. `feat: email admins when the WhatsApp QR session disconnects` (§4).
6. `feat(admin): persistent banner while the WhatsApp session is disconnected` (§5).
7. `docs: whatsapp session guard notes in CLAUDE.md` (§6 بند 7).

الـ commits 1–3 تصلح للدمج والنشر لوحدها (بلا migration) إن أراد المالك إيصال واتساب أولاً.
