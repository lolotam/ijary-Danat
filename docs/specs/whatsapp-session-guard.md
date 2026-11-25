# مواصفة: حارس جلسة واتساب + إيصال الدفع كرسالة معاملات على واتساب

التاريخ: 2026-11-25 — الفرع `feat/whatsapp-session-guard`
الحالة: **معتمدة ومُنفَّذة بعد جولة النقاش الأولى** — القرارات في §8.
الخطة: [`whatsapp-session-guard-plan.md`](./whatsapp-session-guard-plan.md)

## 0. الملخّص

حادثة 2026-11-11 → 2026-11-25: في 07:10 UTC يوم 11 نوفمبر تحوّلت جلسة واتساب QR
(`evolution_connections` صف `id = 1`، `instance_name = "danat"`) من `open` إلى `close`.
`handleConnectionUpdate` (`src/fns/evolutionWebhook.ts:237-247`) كتب الحالة وسكت: لا بريد
للإدارة ولا علامة في `/admin`. فتراكمت 9 إيصالات دفع بوابة (ملفاتها PDF مخزّنة في
`report-documents`) و3 رسائل يدوية في `notifications` بحالة `needs_review` وكود
`session_disconnected` لمدة 14 يوماً.

وظهر عيب ثانٍ: إيصال الدفع على **واتساب** ما زال مشروطاً بـ `tenant.reminders_enabled`
(`src/fns/notifyPaymentSuccess.ts:301` و`:457`)، مع أن الإيصال إثبات دفع لا تذكير، وأن
الشرط نفسه أُزيل عن البريد في `decec8c2`.

| #   | الجزء                          | الخلاصة                                                                                     |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| أ   | إيصال واتساب كرسالة معاملات    | حذف شرط `reminders_enabled` من الموضعين، وتقسيم ملف الاختبار (998 سطراً) بالمسؤولية         |
| ب   | بريد فوري للإدارة عند الانقطاع | سير عمل حدثي + نوع إشعار + قالب، ومطالبة ذرّية واحدة لكل "حلقة انقطاع" (migrations 252–253) |
| ج   | شريط تحذير دائم في `/admin`    | دالة SQL واحدة `whatsapp_session_health()` يقرأها كل موظف                                   |

## 1. الوضع الحالي — ما تم التحقق منه في الكود

### 1.1 من يكتب `last_connection_state`

| الموضع                                                   | متى                           | ماذا يكتب                                                                                                 |
| -------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `handleConnectionUpdate` (`evolutionWebhook.ts:237`)     | ويبهوك `CONNECTION_UPDATE`    | الحالة كما وصلت؛ ومع `open` يمسح `last_qr`                                                                |
| `handleQrUpdate` (`evolutionWebhook.ts:249`)             | ويبهوك `QRCODE_UPDATED`       | `connecting` + `last_qr`                                                                                  |
| `beginEvolutionSession` (`evolutionSession.ts:108`)      | الأدمن يبدأ الاقتران          | يُنشئ الصف (`:135-143`) ثم حالة `client.connect` + `last_qr`                                              |
| `getEvolutionQrStatus` (`evolutionSession.ts:171`)       | استطلاع حوار المسح كل ثانيتين | الحالة الحيّة؛ ومع `open` يختم `connected_number` و`connected_at`                                         |
| `disconnectEvolutionSession` (`evolutionSession.ts:224`) | الأدمن يفصل                   | `close` أو `disconnect_failed`، ويصفّر `connected_number` و`connected_at` (`:248-255`) — **لا يحذف الصف** |
| `requireOpenSession` (`evolutionDelivery.ts:98`)         | إرسال والمسجَّل ليس `open`    | يشفي الصف إلى `open` لو الفحص الحيّ قال `open`                                                            |

أربعة مواضع تكتب `open`. أي "إعادة تسليح" موزّعة عليها هي النوع الذي يُنسى موضع منه —
فمكانها trigger واحد (§4.2).

### 1.2 ثغرتان غير غياب التنبيه

1. **`classifySendFailure` لا يكتب شيئاً في القاعدة** (`src/lib/providers/evolution.ts:151-204`).
   لو الويبهوك لم يصل يبقى الصف `open`، يفشل كل إرسال بكود `session_disconnected`، والواجهة
   تعرض "متصل". شريط يقرأ `last_connection_state` وحده لن يظهر. لذلك مسار الإرسال يسجّل
   الانقطاع الذي رآه (§4.4).
2. **`connected_at` لا يصلح مفتاحاً للحلقة.** يُكتب فقط من استطلاع الحوار
   (`evolutionSession.ts:202`: `row.connected_at ?? now`). بعد انقطاع غير مقصود ثم إعادة مسح
   يبقى التاريخ القديم — فمفتاح مبني عليه لا يتغيّر وانقطاع ثانٍ لا ينبّه.

### 1.3 كيف تصل الرسالة إلى `needs_review`

`deliverEvolutionNotification` (`evolutionDelivery.ts:208`) هو مسار الإرسال الوحيد عبر
Evolution: يستدعيه `dispatchWhatsAppChannel.ts:233` ومحرّر الصندوق (`whatsappChat.ts:64`،
`whatsappMedia.ts:213/248/267`). يرمي `EvolutionProviderError`؛ الصف يصير `failed`، ثم
`runNotificationDrainJob` ينقله إلى `needs_review` لأن الكود في `EVOLUTION_NEEDS_REVIEW`
(`notificationDrainJob.ts:70-79`). لا يتغيّر.

### 1.4 RLS — من يقرأ ماذا

| الجدول                  | المنحة                                                                     | السياسة                                                                                  |
| ----------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `provider_configs`      | كل العمليات لـ `authenticated` (`07_phase5_notifications_reports.sql:132`) | `provider_configs_admin_all`: `has_permission(…, 'settings.integrations')` (`230:89-93`) |
| `evolution_connections` | منحة أعمدة فقط (`179:53-61`) — بلا الأسرار ولا `last_qr`                   | select: `has_permission(…, 'settings.integrations')` (`230:83-86`)                       |

- `243_rls_hoist_auth_checks.sql` أعاد كتابة كل سياسات `public`، فالصيغتان مرفوعتان فعلاً.
- `settings.integrations` مزروعة لدور `admin` فقط (`230:53-65`). أي دور آخر: القراءة من
  الجدولين ترجع **صفر صفوف بلا خطأ**.
- **الفخ:** طلب عمود خارج منحة الأعمدة يرجع `permission denied` (42501). أي عمود جديد لا
  يُضاف إلى `CONNECTION_COLUMNS` (`useEvolutionConnection.ts:37`) دون منحة.
- `usePermissions().isStaff` = أي دور غير `tenant` (`usePermissions.ts:59`)؛ و`is_staff` في
  SQL = مستخدم نشط بدور `admin/accountant/collector/readonly` (`142_deactivation_enforcement.sql:182`).

### 1.5 الاختبارات الشاملة التي يلمسها سير عمل أو نوع إشعار جديد

`src/db/workflowRegistry.sqltest.ts` (`EVENT_KEYS` `:27`، `SEEDED_RECIPIENT_TARGETS` `:65`،
تطابق `WORKFLOW_CATALOG` `:223`)؛ `src/lib/workflowTemplates.test.ts` (تطابق المفاتيح `:28`،
`KNOWN_TEMPLATE_CODES` `:20`، `SENDER_FILE` `:81`)؛ `src/lib/notificationTypes.test.ts`
(عشرون نوعاً بالاسم)؛ `src/components/admin/TemplateEditorDialog.test.tsx:24`
(`toHaveLength(20)`)؛ `src/lib/templateEligibility.test.ts:24`؛
`src/lib/templateVariables.test.ts:37`؛ `src/i18n/dictionary.test.ts:55` (تطابق `ar`/`en`)؛
`src/db/rlsHoistedAuth.sqltest.ts` (لا `auth.uid()` عارية في سياسة).

## 2. الجزء أ — إيصال الدفع على واتساب رسالة معاملات

### 2.1 القرار

`PROACTIVE_REMINDER_TYPES` (`src/fns/notificationChannel.ts:50`) يحصر مفتاح
`reminders_enabled` في `due_reminder` و`overdue_reminder` و`contract_expiry`، وتعليقه يقول إن
بيانات الدخول وإيصالات الدفع "always attempt send". `notifyPaymentSuccess.ts` يخالف ذلك في
موضعين (`:297-301` و`:455-459`). بعد التعديل:

- `waNumber = tenant.whatsapp ?? tenant.mobile` يُحسب مرة واحدة قبل `needsReceipt`.
- `needsReceipt = !tenantSuppressed && targets.includes("tenant") && (Boolean(tenant.email) || Boolean(waNumber))`.
- شرط الإدراج: `waNumber && templateAllowsChannel(receiptCopy.channel, "whatsapp")`.
- تعليق `:303-308` ("neither an email nor reminders") يصير "لا بريد ولا رقم واتساب".

### 2.2 ما يبقى — أربع بوابات

| البوابة                                                     | أين                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `tenantSuppressed` (عقود السطح المحجوبة)                    | `notifyPaymentSuccess.ts:229-232`                                         |
| `targets.includes("tenant")`                                | `:299`                                                                    |
| `templateAllowsChannel(receiptCopy.channel, "whatsapp")`    | `:458`                                                                    |
| `tenant.notifications_paused` (مفتاح المالك، migration 248) | `enqueueNotification.ts:91-94` + `dispatchNotification.ts:144` — لا يُلمس |

`notifications_paused` لا يُقرأ في `notifyPaymentSuccess.ts`؛ يُفرض في `enqueueNotification`
على أي صف `audience = "tenant"` له `tenantId`. المُرسِل يمرّر الاثنين لصف واتساب
(`:469-471`)، ويُثبَّت باختبار (§6 أ-6).

### 2.3 الأثر السلوكي

- مستأجر `reminders_enabled = false` وله رقم واتساب يبدأ يستلم إيصال الدفع مع ملف PDF.
- **الحجم على الإنتاج:** استعلام قراءة فقط على `public.tenants` أجراه المنسّق في 2026-11-25:
  **59 مستأجراً، منهم 2 فقط** `reminders_enabled = false` ولهم `whatsapp` أو `mobile`.
- مستأجر بلا بريد، برقم واتساب، والتذكيرات مطفأة: كان لا يُرسم له PDF؛ الآن يُرسم.
- لا إرسال بأثر رجعي: فحص التكرار (`:264-286`) يطابق مجموعة الدفعات.

### 2.4 حجم الملفات

**`src/fns/notifyPaymentSuccess.test.ts` (998) يُقسَّم** على حدود `describe` الموجودة:

| الملف                                               | المحتوى (سطور الملف الحالي)                                                                           | تقدير |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----- |
| `src/fns/notifyPaymentSuccess.testkit.ts`           | العدّة المشتركة: الـ mocks، `confirmedPayment`، `storedReceiptFor`، `resetPaymentNotifyMocks` (1–174) | ~200  |
| `src/fns/notifyPaymentSuccess.test.ts` (يبقى)       | مفتاح سير العمل، تصنيف النتيجة، القوالب، طريقة الدفع (176–343)                                        | ~210  |
| `src/fns/notifyPaymentSuccess.receiptPdf.test.ts`   | "the receipt pdf rides along with every mail" (345–569)                                               | ~265  |
| `src/fns/notifyPaymentSuccess.recipients.test.ts`   | "recipient targets gate at two levels" (571–620) + الحالات الجديدة                                    | ~230  |
| `src/fns/notifyPaymentSuccess.suppression.test.ts`  | "suppressed roof contracts…" (622–880)                                                                | ~300  |
| `src/fns/notifyPaymentSuccess.deliveryKeys.test.ts` | "one delivery key per payment set per channel" (882–998)                                              | ~155  |

النمط من `src/fns/dispatchNotification.testkit.ts`: `vi.mock` في كل ملف اختبار بمصنع
`async () => (await import("./notifyPaymentSuccess.testkit")).…Module()` كما في
`dispatchNotification.evolution.test.ts:3-9`. النقل حرفي.

**`src/fns/notifyPaymentSuccess.ts` (578) — استخراج واحد:** `PaymentNotifyResult`
و`paymentsMissingPdf` و`missingPdfPayload` و`paymentNotifyOutcome` (`:27-85`) إلى
`src/fns/paymentNotifyResult.ts`؛ الناتج ~520. `const adminCode` و`const receiptCode`
**يبقيان في الملف الأصلي** — `workflowTemplates.test.ts:87-88` يقرأهما منه.

## 3. الجزء ب — الخيار أ (سير عمل مسجَّل)، لا ب (بلا مخطط)

الخيار ب يسقط لثلاثة أسباب:

1. **النوع:** `notifications.type` enum حقيقي؛ تحميل التنبيه على `manual_message` يرفضه
   `92_invoice_event_notification_types.sql` نصاً (فلتر النوع هو ما يجعل السجل قابلاً للاستعمال).
2. **البوابة:** بلا صف `cron_jobs` لا مفتاح إيقاف ولا سجل تشغيل؛ وإضافة المفتاح إلى
   `WORKFLOW_CATALOG` دون صف يكسر `workflowRegistry.sqltest.ts:223`. والصف نفسه يُزرع
   بـ migration — فلا صيغة سليمة "بلا migration".
3. **منع التكرار:** `alreadyNotified` (`notificationSkip.ts:24`) `select` ثم `insert`، غير
   ذرّي؛ والفهرس الفريد على `delivery_key` (251) محصور بنوعي الدفع.

| الكيان          | القيمة                                                                       |
| --------------- | ---------------------------------------------------------------------------- |
| مفتاح سير العمل | `whatsapp-session-disconnected` (`kind = 'event'`، الأهداف `admin, company`) |
| نوع الإشعار     | `whatsapp_session_alert`                                                     |
| رمز القالب      | `whatsapp-session-disconnected` (بريد فقط، صف مخزَّن قابل للتعديل)           |
| ملف المُرسِل    | `src/fns/notifyWhatsappSessionDisconnected.ts`                               |
| حالة الحلقة     | عمودان على `evolution_connections` + trigger (§4.2)                          |

- **migrationان:** `alter type … add value` لا تُستعمل قيمته في نفس الـ transaction
  (نفس سبب 71/72 و88/89 و92/93).
  `db/migrations/252_whatsapp_session_alert_type.sql` (الـ enum فقط) و
  `db/migrations/253_whatsapp_session_guard.sql` (الباقي). آخر ملف موجود 251 (247 غير موجود).
- **لا سياسة RLS جديدة.** العمودان خارج منحة `authenticated`.
- **لا يُستعمل `notifyAdminEvent`:** ترتيبه ثابت ومنع تكراره غير ذرّي. المُرسِل يركّب
  `runEventWorkflow` و`renderAdminEmailCopy` و`enqueueNotification` مباشرة، كما يفعل
  `notifyDepositConfirmed` ولنفس السبب المكتوب في رأس `adminEmailNotification.ts`.

## 4. الجزء ب — التصميم

### 4.1 "حلقة الانقطاع"

الفترة من انتقال الصف إلى `open` حتى انتقاله التالي إلى `open`. **بريد واحد على الأكثر لكل
حلقة**، ولا تهدئة زمنية فوق ذلك (§8 ق3). إعادة المسح تنقل الصف إلى `open` فتبدأ حلقة جديدة.

### 4.2 حالة الحلقة (migration 253)

| العمود                   | النوع                            | المعنى                                                        |
| ------------------------ | -------------------------------- | ------------------------------------------------------------- |
| `disconnect_alert_armed` | `boolean not null default false` | "الجلسة فُتحت، ولم يُرسَل تنبيه ولم يفصلها الأدمن منذ ذلك"    |
| `disconnected_at`        | `timestamptz null`               | لحظة آخر خروج من `open`؛ `null` والجلسة مفتوحة أو لم تُفتح قط |

Trigger `before update`، دالته `public.tg_evolution_session_episode()`:

- `new` = `open` و`old` غير ذلك ← `disconnect_alert_armed := true`، `disconnected_at := null`.
- `old` = `open` و`new` غير ذلك ← `disconnected_at := now()` (التسليح لا يُلمس).

فتُحفظ القاعدة **`state = 'open'` ⇒ `armed = true`** من مكان واحد. جلسة ميتة بلا رقيب لا
تعيد تسليح نفسها: `close ← connecting ← close` لا يمرّ بـ `open`.

**الزرع الأولي** داخل نفس الـ `do` block الذي يضيف العمود:
`disconnect_alert_armed = (last_connection_state = 'open')`.

### 4.3 المطالبة الذرّية

```sql
update public.evolution_connections
   set disconnect_alert_armed = false
 where id = 1 and disconnect_alert_armed and last_connection_state <> 'open'
returning instance_name, connected_number, last_connection_state, disconnected_at;
```

من `supabaseAdmin` كـ `update(...).eq(...).eq(...).neq(...).select(...)` — عبارة `UPDATE`
واحدة؛ المتسابق الثاني ينتظر قفل الصف ثم يخرج بصفر صفوف. **من يرجع له صف هو الوحيد الذي
يرسل.** هذه المطالبة ضرورية وكافية؛ `disconnected_at` في الحمولة معرّف مقروء فقط.

### 4.4 متى يُطلق — مصدران، مُرسِل واحد

**ما يصدره Evolution v2.3.7** (تحقّق منه المنسّق في `whatsapp.baileys.service.ts:350-464`
ولم يُقرأ المصدر في هذه الجلسة): عند `close` بسبب قابل لإعادة الاتصال يستدعي
`connectToWhatsapp()` داخلياً **ولا يصدر** `CONNECTION_UPDATE: close`. يصدره فقط في الحالة
النهائية (401 `loggedOut`، 403، 402، 406) بعد `client.end()`، أو يصدر `state: "refused"` عند
بلوغ حد محاولات QR. فكل `close`/`refused` يصل إلينا نهائي، ولا حاجة لمهلة تأكيد.

**المصدر 1 — الويبهوك.** `handleConnectionUpdate` يكتب الحالة كما يفعل اليوم، ثم لأي حالة
**ليست `open` ولا `connecting`** (تشمل `close` و`refused`) يستدعي
`void confirmSessionDisconnect()` — فوراً وبلا `await`، نفس نمط
`backfillChatAvatarsInBackground` (`:185`). لا مؤقّت ولا حالة على مستوى الموديول.
`confirmSessionDisconnect()`:

1. يقرأ الصف. `open` أو غير مسلَّح ← خروج (لا فحص حيّ).
2. المزوّد غير مفعّل ← خروج.
3. فحص حيّ واحد `client.connectionState`:
   - `open` ← يشفي الصف (كما في `requireOpenSession`، بشرط أن الصف ما زال مقترناً وليست حالته
     `disconnecting`)، لا تنبيه. هذا ما يحمي من ويبهوك وصل خارج ترتيبه دون إعادة فتح فصل يدوي.
   - `EvolutionApiError` بحالة 404 ← النسخة حُذفت من البوابة؛ انقطاع مؤكَّد ← تنبيه.
   - أي فشل آخر (البوابة لا تجيب) ← لا تنبيه؛ يبقى مسلَّحاً والمصدر 2 قائم.
   - أي حالة أخرى غير `open` ← تنبيه.

**المصدر 2 — إرسال فشل.** في `deliverEvolutionNotification`: `try/catch` حول
`requireOpenSession` + `sendWithEvolution`؛ عند `EvolutionProviderError` بكود
`session_disconnected` أو `instance_missing` يستدعي `reportSendSessionDisconnected()` ثم
**يعيد رمي الخطأ نفسه**. الدالة:

1. تكتب `last_connection_state = 'close'` **بشرط أن المسجَّل `open`** — تسدّ ثغرة §1.2(1):
   الـ trigger يختم `disconnected_at` والشريط يظهر حتى لو الويبهوك لم يصل.
2. تستدعي المُرسِل.

`instance_missing` مضاف هنا لأنه بلا ذلك صف `open` على نسخة محذوفة لا ينبّه ولا يُظهر
الشريط أبداً؛ والكودان معاً في `EVOLUTION_NEEDS_REVIEW` بنفس العلاج (إعادة الربط).
"لم يُقترن قط" (`evolutionDelivery.ts:64`) يرمي `session_disconnected` لكن لا صف يُطالَب به ←
لا بريد. `partial_send` لا يُطلق. `src/lib/providers/evolution.ts` **لا يُلمس**.

### 4.5 المُرسِل `notifyWhatsappSessionDisconnected({ source })`

لا يرمي أبداً. الترتيب:

1. **نظرة رخيصة قبل السجل** (قراءة واحدة): غير مسلَّح، أو `open`، أو لا صف ← خروج دون لمس
   `cron_jobs`. الإرسال الفاشل رقم 2…N في نفس الحلقة يكلّف `select` واحداً.
2. مزوّد `evolution_api` غير مفعّل ← خروج (الاقتران قبل التفعيل ترتيب طبيعي،
   `evolutionSession.ts:47-52`).
3. `runEventWorkflow({ key: "whatsapp-session-disconnected", … })`:
   - موقوف ← `skipped` (يبقى مسلَّحاً).
   - `resolveNotificationRecipients(targets)` فارغ ← `skipped` بسبب "No admin email
     recipients configured." **قبل** المطالبة، فيبقى مسلَّحاً ويظهر سوء الإعداد.
   - المطالبة (§4.3). صفر صفوف ← `skipped` حميد "Already alerted for this outage."
   - `renderAdminEmailCopy({ code: "whatsapp-session-disconnected", … })` ثم
     `enqueueNotification` (`type: "whatsapp_session_alert"`، `channel: "email"`،
     `audience: "admin"`؛ الحمولة: `source`، `observed_state`، `disconnected_at`، `recipients`).
   - البناء أو الإدراج رمى، أو `enqueueNotification` رجّع `null` ← **إرجاع المطالبة**
     (`armed = true` بشرط أن الصف ما زال مقترناً وحالته خارج `open` و`disconnecting`) ثم `skipped`
     بالسبب. ملاحظة: إذا ضُبط القالب بالخطأ على قناة غير البريد فيرجع `null`، تعيد كل محاولة
     لاحقة تشغيل السير وتسجيل `skipped` في `cron_jobs` عن قصد حتى يظهر سوء الإعداد.

صف بريد وُلد ثم فشل تسليمه يبقى `failed` ومهمة التصريف تعيده — مسار قائم.

**متغيرات القالب:** `connected_number`، `instance_name`، `state`، `disconnected_at` (منسَّق بتوقيت
الكويت `Asia/Kuwait` في نص البريد، بينما يبقى بصيغة ISO الخام داخل `payload`)،
`parked_count`، `settings_url` (`APP_BASE_URL` + `/admin/settings/integrations`). اللغة من
`loadCompanyDefaults()`. الرمز يُختار حرفياً بصيغة `code: "…"` التي يلتقطها
`TEMPLATE_SELECTION_PATTERN` (`workflowTemplates.test.ts:112`).

### 4.6 الفصل المقصود من الأدمن — لا إنذار

`disconnectEvolutionSession` يستدعي `client.logout`، وويبهوك `close` قد يصل **قبل** كتابة
الحالة النهائية. لذلك أول ما تفعله بعد فحص الصلاحية وتحميل الصف، وقبل أي نداء للبوابة:

```ts
update({ disconnect_alert_armed: false, last_connection_state: "disconnecting" }).eq("id", 1);
```

- نزع التسليح أولاً ← أي مطالبة لاحقة في هذه الحلقة ترجع صفراً.
- `disconnecting` في نفس العبارة يحفظ قاعدة §4.2: لا يبقى صف `open` غير مسلَّح لو انهارت
  الدالة في المنتصف.
- فشل هذه الكتابة يرمي قبل `logout`.
- الكتابة النهائية (`close` / `disconnect_failed`) تؤكّد `disconnect_alert_armed: false` وتصفّر
  `last_qr` و`connected_number` و`connected_at`.

`beginEvolutionSession` **لا** ينزع التسليح: "ربط" والجلسة مفتوحة (تدوير السر) كان سيترك
صفاً `open` غير مسلَّح بلا انتقال يعيد تسليحه — انقطاع صامت.

### 4.7 الهشاشة

- **الويبهوك:** `void confirmSessionDisconnect().catch(...)` يُطلق من نهاية
  `handleConnectionUpdate` بعد نجاح كتابة الحالة في القاعدة، غير منتظَر، وجسمه كله داخل
  `try/catch` يسجّل ولا يرمي — فلا يصل أي فشل في الفحص الحيّ أو البريد إلى `try` الخاص بـ
  `respondToEvolutionWebhook`، والرد 200 يخرج فوراً.
- **الإرسال:** `reportSendSessionDisconnected` داخل `try/catch` خاص بها، والخطأ الأصلي يُعاد
  رميه بعينه — `error_code` المحفوظ لا يتغيّر.
- **السجل:** `readWorkflowGate` و`recordWorkflowRun` يبتلعان أخطاءهما (`workflowRegistry.ts:28-87`).
- البريد يخرج عبر مزوّد البريد، لا Evolution — لا حلقة ارتدادية.

### 4.8 جدول الحالات

| السيناريو                                         | بريد؟               | لماذا                                           |
| ------------------------------------------------- | ------------------- | ----------------------------------------------- |
| واتساب يفصل الجهاز (401)، الويبهوك يصل            | نعم، فوراً          | المصدر 1 بعد الفحص الحيّ                        |
| حد محاولات QR، ويبهوك `refused`                   | نعم إن كان مسلَّحاً | `refused` ليست `open` ولا `connecting`          |
| الويبهوك لم يصل                                   | عند أول إرسال فاشل  | المصدر 2؛ ويُكتب `close` فيظهر الشريط           |
| ويبهوكات `close` متكررة في نفس الحلقة             | واحد                | بعد المطالبة الأولى: غير مسلَّح، خروج قبل الفحص |
| مئة إرسال فاشل أثناء التصريف                      | واحد                | النظرة الرخيصة                                  |
| ويبهوك وإرسال فاشل في نفس اللحظة                  | واحد                | `UPDATE` واحد يكسبه واحد                        |
| إعادة اتصال عابرة داخل Evolution                  | لا                  | لا ويبهوك `close`؛ `connecting` لا يُطلق        |
| ويبهوك `close` خارج ترتيبه والجلسة فعلاً مفتوحة   | لا                  | الفحص الحيّ `open` ← شفاء                       |
| الأدمن يضغط "فصل"                                 | لا                  | نُزع التسليح قبل `logout`                       |
| حوار المسح: `connecting`، انتهاء QR، ولم تُفتح قط | لا                  | غير مسلَّح                                      |
| المزوّد غير مفعّل                                 | لا                  | §4.5 بند 2                                      |
| إعادة مسح 10:05 ثم انقطاع جديد 10:10              | نعم، فوراً          | `open` سلّح حلقة جديدة؛ لا تهدئة                |
| لا عنوان بريد للإدارة                             | لا — `skipped` ظاهر | يبقى مسلَّحاً                                   |

**خطر مقبول:** إرسال وقع أثناء ثواني إعادة اتصال عابرة يرى `connecting`، فيُركن (سلوك
قائم اليوم) ويخرج عنه بريد. رسالة حقيقية تعطّلت فعلاً، والإرسال التالي يشفي الصف.

## 5. الجزء ج — شريط التحذير

### 5.1 `public.whatsapp_session_health()`

`language sql stable security definer set search_path = public, pg_temp`، ترجع `jsonb`:

```json
{
  "enabled": true,
  "paired": true,
  "state": "close",
  "settling": false,
  "disconnected_at": "2026-11-11T07:10:00Z",
  "parked_count": 12
}
```

| الحقل          | التعريف                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| (الناتج كله)   | `null` إن لم يكن `(select public.is_staff((select auth.uid())))`                                     |
| `enabled`      | `provider_configs.is_enabled` لصف `evolution_api`                                                    |
| `paired`       | `coalesce(connected_number is not null or connected_at is not null, false)` — **لا** وجود الصف       |
| `state`        | `last_connection_state` كما هو                                                                       |
| `settling`     | `state = 'connecting' and disconnected_at > now() - interval '60 seconds'` — بساعة الخادم            |
| `parked_count` | إشعارات `error_code in ('session_disconnected','instance_missing')` بحالة `failed` أو `needs_review` |

- وجود الصف لا يعني اقتراناً: `beginEvolutionSession` يُنشئه قبل المسح، و
  `disconnectEvolutionSession` يبقيه ويصفّر الحقلين — والحالتان يجب أن تعرضا نص "لم يُربط".
- حدّ معروف: جلسة فُتحت وأُغلق الحوار قبل أن يختم الاستطلاع `connected_at`، ثم انقطعت ←
  `paired = false` والنص "لم يُربط" بدل "مفصولة". الشريط يظهر والزر نفسه؛ النص فقط أقل دقة.
- `settling` موجود لأن إعادة الاتصال العابرة تصدر ويبهوك `connecting` (يُكتب في الصف
  لثوانٍ)؛ بلا هذا الحقل قد يلتقطه استطلاع الشريط ويعرض إنذاراً كاذباً حتى 60 ثانية. يُحسب
  في SQL بـ `now()` — لا ساعة متصفح ولا انحراف. `close` و`refused` لا يشملهما: يظهران فوراً.
- لا أسرار ولا أرقام ولا QR. `revoke execute … from public, anon` ثم `grant` لـ
  `authenticated` و`service_role`.

**لماذا دالة لا قراءة الجدولين:** القراءة المباشرة تعمل بلا خطأ (§1.4) لكن كل دور بلا
`settings.integrations` يرى صفر صفوف فلا يرى الشريط. المحاسب الذي يرسل الرسائل اليدوية أول
من يجب أن يعرف. وهي طلب واحد بدل اثنين على كل تحميل لـ `/admin`.

### 5.2 قاعدة الظهور — دالة نقية بلا ساعة

`whatsappSessionBannerState(health)` في `src/lib/whatsappSessionBanner.ts`:

| الشرط (بالترتيب)                          | الناتج         |
| ----------------------------------------- | -------------- |
| `health` غير موجود (تحميل، خطأ، غير موظف) | `hidden`       |
| `enabled` ليست `true`                     | `hidden`       |
| `state === "open"`                        | `hidden`       |
| `settling === true`                       | `hidden`       |
| `paired === false`                        | `never_paired` |
| غير ذلك                                   | `disconnected` |

الشرطان الأولان يمنعان المطلوب منعه: **لا شريط كاذب والمزوّد معطّل**، و**لا حالة خطأ** —
فشل الاستعلام يخفي الشريط ولا يحجب الغلاف.

### 5.3 المكوّن والموضع

- `src/hooks/useWhatsappSessionHealth.ts` — `useQuery(["whatsapp-session-health"])` على
  `supabase.rpc("whatsapp_session_health")`، `refetchInterval: 60_000`، `staleTime: 30_000`،
  `retry: false`.
- `src/components/admin/WhatsappSessionBanner.tsx` — على `src/components/ui/alert.tsx`،
  `role="status"`، ألوان تحذير كهرمانية، غير قابل للإغلاق.
- `src/routes/admin.tsx`: سطر بين `</header>` (`:138`) و`<main>` (`:139`)، داخل العمود الذي
  يحمل `dir={dir}` — الاتجاه موروث. يُرسم في فرع الموظف فقط.
- إبطال `["whatsapp-session-health"]` بعد نجاح `useBeginEvolutionSession`
  و`useDisconnectEvolutionSession`، وعند وصول `useEvolutionQrStatus` إلى `open`.

### 5.4 النص والأزرار (`src/i18n/locales/{ar,en}/admin.ts`)

| المفتاح                             | عربي                                                             | إنجليزي                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `admin.whatsappBanner.disconnected` | جلسة واتساب مفصولة — رسائل واتساب لا تُرسل حتى يُعاد مسح رمز QR. | The WhatsApp session is disconnected — messages are not sent until the QR code is rescanned. |
| `admin.whatsappBanner.neverPaired`  | مزوّد واتساب مفعّل لكن لا يوجد رقم مربوط.                        | The WhatsApp provider is enabled but no number is linked.                                    |
| `admin.whatsappBanner.parked`       | {count} رسالة بانتظار المراجعة.                                  | {count} messages are waiting for review.                                                     |
| `admin.whatsappBanner.reconnect`    | إعادة الربط                                                      | Reconnect                                                                                    |
| `admin.whatsappBanner.viewParked`   | عرض الرسائل المعلّقة                                             | View held messages                                                                           |
| `admin.whatsappBanner.askAdmin`     | أبلغ مدير النظام لإعادة الربط.                                   | Ask an administrator to reconnect it.                                                        |

- "إعادة الربط" ← `/admin/settings/integrations`، لمن عنده `PERMISSIONS.SETTINGS_INTEGRATIONS`
  فقط (الصفحة ترفض غيره، `admin.settings.integrations.tsx:58`). غيره يرى `askAdmin` بلا رابط.
- "عرض الرسائل المعلّقة" ← `/admin/settings/notifications`، حين `parked_count > 0` ولمن عنده
  `PERMISSIONS.NOTIFICATIONS_READ`. المسار `/admin/notifications` **غير موجود**.

## 6. الاختبارات

### أ — إيصال واتساب (`notifyPaymentSuccess.recipients.test.ts`)

1. تذكيرات مطفأة + واتساب + بلا بريد ← `receipt:whatsapp` ويُرسم PDF مرة واحدة.
2. تذكيرات مطفأة + بريد + واتساب ← الصفان معاً.
3. `whatsapp = null` و`mobile` موجود ← الصف يذهب إلى `mobile`.
4. قالب `receipt` قناته `email` ← لا صف واتساب.
5. أهداف بلا `tenant` + تذكيرات مطفأة ← لا صف مستأجر.
6. صف واتساب يحمل `audience: "tenant"` و`tenantId` (ما تعتمد عليه بوابة
   `notifications_paused`، المغطّاة في `enqueueNotification.test.ts` و`dispatchNotification.test.ts`).
7. في `…suppression.test.ts`: عقد محجوب + تذكيرات مطفأة + واتساب ← لا صف مستأجر.

### ب — التنبيه

`src/fns/notifyWhatsappSessionDisconnected.test.ts`:

1. مسلَّح ومفصول ← صف واحد `whatsapp_session_alert`، والحمولة تحمل `source` و`disconnected_at`.
2. غير مسلَّح ← لا قراءة لـ `cron_jobs` ولا `record_cron_run` ولا إدراج.
3. المطالبة ترجع صفراً ← `skipped` حميد. 4. المزوّد معطّل ← لا شيء، ولا مطالبة.
4. سير العمل موقوف ← `skipped`، ولا مطالبة. 6. لا مستلمين ← `skipped` بالسبب، ولا مطالبة.
5. `enqueueNotification` يرمي ← تُرجَع المطالبة، ولا يخرج استثناء.
6. `enqueueNotification` يرجّع `null` ← تُرجَع المطالبة.
7. تنبيه سابق عمره 5 دقائق + حلقة جديدة مسلَّحة ← **يُرسل** (لا تهدئة).

`src/fns/evolutionSessionWatch.test.ts` (بلا مؤقتات وهمية):

10. الصف `open` أو غير مسلَّح ← لا فحص حيّ ولا مُرسِل.
11. الفحص الحيّ `open` ← يُشفى الصف، لا مُرسِل. 12. الفحص يفشل بلا جواب ← لا مُرسِل.
12. الفحص `close` ← المُرسِل مرة واحدة بـ `source: "webhook"`.
13. الفحص `connecting` ← المُرسِل (غير `open` مؤكَّد). 15. الفحص 404 ← المُرسِل.
14. المُرسِل يرمي ← الدالة لا ترفض.

`src/fns/evolutionWebhook.test.ts` (357، يتّسع):

17. `close` ← 200 والتأكيد استُدعي.
18. `refused` ← استُدعي. 19. `connecting` و`open` ← لم يُستدعَ.
19. التأكيد يرفض ← الرد 200 ولا unhandled rejection.

`src/fns/evolutionDelivery.session.test.ts` (جديد):

21. `session_disconnected` ← التقرير استُدعي، والخطأ المرمي هو نفسه بكوده.
22. `instance_missing` ← التقرير استُدعي. 24. `number_not_on_whatsapp` ← لا تقرير.
23. التقرير يرمي ← الخطأ الأصلي ما زال هو المرمي.

`src/fns/evolutionSession.test.ts` (جديد):

25. كتابة نزع التسليح + `disconnecting` تسبق `logout`. 26. فشلها ← يرمي و`logout` لم يُستدعَ.

`src/db/whatsappSessionGuard.sqltest.ts` (Postgres حقيقي، `withRollback`):

27. الانتقال إلى `open` يسلّح ويصفّر `disconnected_at`؛ الخروج يختمه ولا يلمس التسليح.
28. المطالبة مرتين ← صف ثم صفر؛ والحالة `open` ← صفر.
29. مطالبة ثم `open` ثم `close` ← المطالبة تنجح من جديد.
30. `close ← connecting ← close` بعد المطالبة ← لا إعادة تسليح.
31. `authenticated` لا يقرأ العمودين الجديدين (`permission denied`).
32. `whatsapp_session_health()`: أدمن ومحاسب بلا `settings.integrations` ← كائن كامل؛
    مستأجر ← `null`؛ `anon` ← `permission denied`.
33. `paired`: صف بلا `connected_number`/`connected_at` (بعد "ربط" بلا مسح، وبعد "فصل") ←
    `false`؛ بأحدهما ← `true`؛ بلا صف ← `false`.
34. `settling`: `connecting` و`disconnected_at` قبل 10 ثوانٍ ← `true`؛ قبل دقيقتين ←
    `false`؛ `close` قبل 10 ثوانٍ ← `false`.
35. `enabled` تتبع `provider_configs.is_enabled`؛ `parked_count` يعدّ الكودين بحالتي
    `failed`/`needs_review` فقط.
36. قيمة الـ enum موجودة، صف `cron_jobs` من نوع `event`، صف القالب نشط بجسمين؛ وإعادة
    الزرع لا تعيد تفعيل سير عمل موقوف.

### ج — الشريط

`src/lib/whatsappSessionBanner.test.ts`: صف لكل سطر من §5.2، زائد `state = "refused"` ←
`disconnected`، و`disconnected_at = null` مع `close` ← `disconnected`.

`src/components/admin/WhatsappSessionBanner.test.tsx`:

37. `hidden` وخطأ الاستعلام ← لا شيء في الـ DOM.
38. بصلاحية التكاملات ← رابط إلى `/admin/settings/integrations`؛ بلاها ← `askAdmin` بلا رابط.
39. `parked_count = 0` ← لا رابط ثانوي؛ `> 0` مع `notifications.read` ← موجود.
40. `never_paired` ← نص `neverPaired`.

الاختبارات الشاملة (§1.5) تُحدَّث في نفس الـ PR — ملفاً ملفاً في الخطة §3.

## 7. خارج النطاق

- **الـ 12 رسالة المعلّقة من الحادثة** وإعادة الطابور تلقائياً عند عودة الجلسة: قرار بشري
  لكل صف (إيصال عمره 14 يوماً؛ وقاعدة التصريف نفسها أن المتأخر 72 ساعة يُلغى). الشريط
  والبريد يعرضان العدد فقط.
- مهمة cron تراقب الجلسة دورياً (§8 ق2)، وتنبيه "عادت الجلسة".
- انقطاع Gmail أو مزوّدي واتساب الآخرين.
- تطبيق الـ migrations على الإنتاج والدمج — في الخطة، بموافقة المالك.

## 8. قرارات جولة النقاش الأولى (2026-11-25)

**متفق عليه دون خلاف**

- **ن1:** الشريط لكل الموظفين عبر الدالة؛ الزر لصاحب `settings.integrations`. داخل الدالة
  `public.is_staff((select auth.uid()))`.
- **ن4:** استخراج `paymentNotifyResult.ts` يبقى. **ن5:** صف القالب المخزَّن يبقى.
- **ن6:** مُغلقة — 2 من 59 مستأجراً (§2.3).
- **ن7، ن8:** `src/lib/providers/evolution.ts` لا يُلمس؛ كتابة `close` المشروطة كافية،
  وحالة 4xx مع فحص بلا جواب تستحق مراجعة بشرية على أي حال.

**نقاط الخلاف**

| #   | النقطة                          | القرار                  | السبب                                                                                                                                                                                                  |
| --- | ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ق1  | تعريف `paired`                  | **تنازل**               | الصف يوجد قبل المسح وبعد الفصل؛ `exists(row)` كان يعرض النص الخطأ في الحالتين. التعريف الجديد في §5.1                                                                                                  |
| ق2أ | مؤقّت الـ 60 ثانية + `refused`  | **تنازل**               | Evolution لا يصدر `close` في الانقطاع العابر، فالمؤقّت كان يحل مشكلة غير موجودة ويضيف ضياعاً عند إعادة التشغيل وتأخيراً دقيقة. تأكيد فوري لأي حالة غير `open`/`connecting`، والفحص الحيّ يبقى          |
| ق2ب | `TRANSIENT_GRACE_MS` في المتصفح | **تنازل مع تعديل ضيّق** | ساعة المتصفح تُحذف والدالة النقية بلا `nowMs`. لكن ويبهوك `connecting` العابر حقيقي ويُكتب في الصف؛ فحقل `settling` يُحسب في SQL بساعة الخادم ويخصّ `connecting` وحدها                                 |
| ق3  | تهدئة 30 دقيقة                  | **تنازل**               | الخروج الصامت بلا مراقب خلفي يضيّع تنبيه الانقطاع الثاني نهائياً. والتسليح لا يعود إلا بـ `open` حقيقي، فبريدان في 30 دقيقة يعنيان أن إنساناً أعاد الربط وانقطع من جديد — اللحظة التي يجب أن يعرف فيها |
| ق4  | حجم المواصفة                    | **موافق**               | الملف تحت 520 سطراً                                                                                                                                                                                    |

**إضافتان من هذه الجولة (خارج ما طُلب، للمراجعة):**

1. `instance_missing` يُطلق المصدر 2 مثل `session_disconnected` (§4.4)، ويدخل `parked_count`.
2. فحص حيّ يرجع 404 في `confirmSessionDisconnect` يُعدّ انقطاعاً مؤكَّداً لا "بوابة لا تجيب".
   هل يحذف Evolution النسخة بعد 401؟ **unverified** — الفرع يغطي الحالتين.

**مؤجَّل:** مهمة `whatsapp-session-watch` الدورية (ق2). بعد حذف المؤقّت لم يبق شيء في
الذاكرة يضيع؛ الفجوة الباقية هي انقطاع بلا ويبهوك وبلا أي إرسال، وتُغطّى عند أول إرسال.
