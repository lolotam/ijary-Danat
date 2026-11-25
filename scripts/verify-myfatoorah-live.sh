#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# verify-myfatoorah-live.sh — فحص قطع البيئة من Sandbox إلى Live في ماي فاتورة
#
# يجري هذا السكربت على خادم الإنتاج (الدوكَر هوست)، وليس محليًا. يتحقق أن
# الحاوية تعمل بمفتاح Live فعلًا، وأن نقطة النهاية الحيّة تقبل المفتاح، وأن
# واجهة الويب هوك مغلقة أمام الطلبات غير الموقّعة، ويعرض أحدث حدث ويب هوك.
#
# Usage (on the production host, after a deploy):
#   bash /etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code/scripts/verify-myfatoorah-live.sh
#
# Exit 0: every HARD check passes and a signed callback since the current
#         container start proves the webhook secret (LIVE verified).
# Exit 2: every HARD check passes but no such callback yet (UNVERIFIED —
#         make one live payment, then re-run).
# Exit 1: at least one HARD failure. WARN lines are informational.
# -----------------------------------------------------------------------------

set -uo pipefail

# بصمة SHA-256 للرمز العام الذي تنشره ماي فاتورة في مستنداتها للتجربة (Sandbox).
# مطابقتها تعني أن مفتاح التجربة ما زال مضبوطًا في الإنتاج. البصمة بدل الرمز
# نفسه حتى لا يحمل المستودع أي مفتاح حرفيًا، حتى لو كان علنيًا (قاعدة المشروع).
KNOWN_SANDBOX_TOKEN_SHA256="75761427bec95afe1f1449baacb88b8d4509e0e646ab603250a66aad212474e4"

LIVE_BASE="https://api.myfatoorah.com"
SANDBOX_BASE="https://apitest.myfatoorah.com"

APP_GLOB="danatfuture-vk5hnn"
DB_CONTAINER="danatfuture-supabase-ozoxsa-db-1"
APP_URL="https://danat-future.com"
WEBHOOK_PATH="/api/public/myfatoorah-webhook"

HARD_FAIL=0

# المنطقة الجذرية لكل فحص: تطبع سطر نتيجة وتوقف الفشل الصلب العدّاد.
pass() { echo "PASS  $*"; }
warn() { echo "WARN  $*"; }
fail() { echo "FAIL  $*"; HARD_FAIL=$((HARD_FAIL + 1)); }

# تحديد حاوية التطبيق العاملة حاليًا (أحدث حاوية قيد التشغيل).
APP_CONTAINER="$(docker ps --format '{{.Names}}' | grep "$APP_GLOB" | head -1)"
if [ -z "$APP_CONTAINER" ]; then
  fail "no running app container matches '$APP_GLOB'"
  exit 1
fi
pass "app container: $APP_CONTAINER"

# --- 1) متغيرات البيئة داخل الحاوية --------------------------------------
BASE_URL="$(docker exec "$APP_CONTAINER" printenv MYFATOORAH_BASE_URL)"
# البوابة (src/fns/myfatoorahGateway.ts) تزيل الشرطة المائلة الأخيرة قبل كل طلب،
# فقيمة تنتهي بها صحيحة تشغيلياً ويجب ألا تُعدّ فشلاً.
BASE_URL="${BASE_URL%/}"
API_KEY="$(docker exec "$APP_CONTAINER" printenv MYFATOORAH_API_KEY)"
WEBHOOK_SECRET="$(docker exec "$APP_CONTAINER" printenv MYFATOORAH_WEBHOOK_SECRET)"

[ "$BASE_URL" = "$LIVE_BASE" ] \
  && pass "MYFATOORAH_BASE_URL = $BASE_URL" \
  || fail "MYFATOORAH_BASE_URL = '$BASE_URL' (expected $LIVE_BASE)"

if [ -n "$API_KEY" ] && [ "${#API_KEY}" -ge 40 ]; then
  API_KEY_SHA256="$(printf '%s' "$API_KEY" | sha256sum | cut -d' ' -f1)"
  if [ "$API_KEY_SHA256" = "$KNOWN_SANDBOX_TOKEN_SHA256" ]; then
    fail "MYFATOORAH_API_KEY is the PUBLIC sandbox demo token (len ${#API_KEY})"
  else
    pass "MYFATOORAH_API_KEY present ($(echo -n "$API_KEY" | cut -c1-12)…, len ${#API_KEY})"
  fi
else
  fail "MYFATOORAH_API_KEY missing or too short (len ${#API_KEY})"
fi

if [ -n "$WEBHOOK_SECRET" ] && [ "${#WEBHOOK_SECRET}" -ge 32 ]; then
  pass "MYFATOORAH_WEBHOOK_SECRET present ($(echo -n "$WEBHOOK_SECRET" | cut -c1-4)…, len ${#WEBHOOK_SECRET})"
else
  fail "MYFATOORAH_WEBHOOK_SECRET missing or too short (len ${#WEBHOOK_SECRET})"
fi

# --- 2) المفتاح مقابل نقطتي النهاية (من الهوست) ---------------------------
# فحص واحد يعيد كود HTTP فقط؛ لا يطبع المفتاح أبدًا، ولا يضعه في وسائط
# العملية: ترويسة التفويض تُمرَّر إلى curl عبر ملف إعداد على stdin (-K -)
# حتى لا تظهر في ps أو /proc/*/cmdline طوال مدة الطلب.
probe() {
  printf 'header = "Authorization: Bearer %s"\n' "$2" \
    | curl -s -o /dev/null -w '%{http_code}' --max-time 15 -K - \
        -X POST "$1/v2/GetPaymentStatus" \
        -H "Content-Type: application/json" \
        -d '{"Key":"0","KeyType":"InvoiceId"}'
}

# ما يُقبل: 200 أو 400 فقط — أي منهما يعني أن المفتاح صُدِّق ثم رُفض الاستعلام
# الوهمي (Key=0). أي رمز آخر (000 = فشل نقل عند curl، 3xx، 404، 5xx) ليس دليلاً
# على المفتاح، فيُعدّ فشلاً صلباً بدل أن يمرّ كـ "مقبول".
LIVE_CODE="$(probe "$LIVE_BASE" "$API_KEY")"
case "$LIVE_CODE" in
  200|400) pass "live endpoint accepts the key (HTTP $LIVE_CODE; 400 'no data' = authenticated)" ;;
  401)     fail "live endpoint rejects the key (401) — token invalid or still sandbox" ;;
  000|'')  fail "live endpoint unreachable (curl transport error / timeout)" ;;
  *)       fail "live endpoint answered HTTP $LIVE_CODE — unexpected; gateway unavailable or URL wrong" ;;
esac

SANDBOX_CODE="$(probe "$SANDBOX_BASE" "$API_KEY")"
if [ "$SANDBOX_CODE" = "401" ]; then
  pass "sandbox endpoint rejects the key (401) — key is live-only"
else
  warn "sandbox endpoint answered HTTP ${SANDBOX_CODE:-timeout} — a live-only key should be rejected here"
fi

# --- 3) المفتاح من داخل الحاوية (نفس ما يفعله التطبيق فعلًا) ----------------
# مهلة 15 ثانية كما تفعل البوابة نفسها (AbortSignal.timeout في myfatoorahGateway.ts)؛
# بلا حدّ زمني قد يعلّق الفحص إلى الأبد عند اتصال يُقبل ولا يُجاب. فشل النقل
# يُطبع 000 كما يفعل curl حتى يمرّ بالمسار نفسه أدناه.
INSIDE_CODE="$(docker exec "$APP_CONTAINER" bun -e '
try {
  const r = await fetch("'"$LIVE_BASE"'/v2/GetPaymentStatus", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.MYFATOORAH_API_KEY,
               "Content-Type": "application/json" },
    body: JSON.stringify({ Key: "0", KeyType: "InvoiceId" }),
    signal: AbortSignal.timeout(15000),
  });
  console.log(r.status);
} catch {
  console.log("000");
}
' 2>/dev/null | tail -1)"
case "$INSIDE_CODE" in
  200|400) pass "in-container call to live endpoint authenticated (HTTP $INSIDE_CODE)" ;;
  *)       fail "in-container call to live endpoint failed (HTTP ${INSIDE_CODE:-none}; only 200/400 prove the key)" ;;
esac

# --- 4) واجهة الويب هوك مغلقة أمام الطلبات غير الموقّعة ---------------------
# الجسم يحمل علامة "probe": المعالج يسجّل كل نداء مرفوض التوقيع في webhook_events،
# فتبقى العلامة في الجدول دليلاً على أن الصف مسبار هذا الفحص لا نداء بوابة.
PROBE_BODY='{"probe":"verify-myfatoorah-live"}'
# يُحتفظ بجسم الردّ لا بالرمز وحده: 401 قد يأتي من طبقة أمام التطبيق (وكيل /
# تحكم وصول) لا تصل نداءات البوابة عبرها أصلاً. المعالج يردّ بجسم مميّز
# {"error":"Invalid webhook signature."} فهو الدليل على أن التطبيق نفسه أجاب.
WH_RESPONSE="$(curl -s --max-time 15 -w '\n%{http_code}' \
  -X POST "$APP_URL$WEBHOOK_PATH" -H 'Content-Type: application/json' -d "$PROBE_BODY")"
WH_CODE="${WH_RESPONSE##*$'\n'}"
WH_BODY="${WH_RESPONSE%$'\n'*}"
# المعالج (src/fns/myfatoorahWebhook.ts) يردّ 401 على أي جسم غير موقّع؛ 503 يعني
# أن MYFATOORAH_WEBHOOK_SECRET غير مضبوط، و403 يعني أن شيئًا أمام التطبيق (WAF /
# وكيل) يحجب الطلب — وسيحجب نداءات البوابة الحقيقية أيضًا. كلاهما فشل.
case "$WH_CODE" in
  401)
    if printf '%s' "$WH_BODY" | grep -q "Invalid webhook signature"; then
      pass "webhook endpoint is fail-closed to unsigned POSTs (HTTP 401 from the app itself)"
    else
      fail "webhook endpoint answered 401 but not with the app's body (${WH_BODY:0:80}) — an upstream layer is answering instead of the app"
    fi ;;
  503)    fail "webhook endpoint answered 503 — MYFATOORAH_WEBHOOK_SECRET is not set in the container" ;;
  403)    fail "webhook endpoint answered 403 — blocked before the app (WAF/proxy); real gateway callbacks would be blocked too" ;;
  000|'') fail "webhook endpoint unreachable (curl transport error / timeout)" ;;
  *)      fail "webhook endpoint answered HTTP $WH_CODE to an unsigned POST — expected 401" ;;
esac

# --- 5) إثبات سرّ الويب هوك وأحدث حدث ------------------------------------
# الدليل الوحيد الذي لا يمكن تزويره على صحة سرّ HMAC المضبوط هو نداء بوابة
# بتوقيع صالح وصل **بعد أن صارت الحاوية الحالية وحدها تخدم**: السرّ لا يتغيّر
# إلا بإعادة تشغيل الخدمة، فكل صف أقدم من ذلك قد يكون وُقّع بسرّ سابق. بلا هذا الدليل لا يُعلن
# الفحص "verified" بل "unverified" (كود خروج 2) حتى تصل أول دفعة حقيقية.
#
# أي صف مرفوض التوقيع قد يكون من أي مرسل على الإنترنت (نقطة النهاية عامة)، حتى
# لو حمل شكل نداء بوابة ونوع حدث معروف، فلا يصلح دليلاً لإفشال الفحص ولا
# لإنجاحه؛ يُبلَّغ عنه تحذيراً مع تفسيره. الفشل الصلب هنا محصور بتعذّر الاستعلام.
#
# "النداء الحقيقي الشكل" = جسم يحمل كائن Data كما ترسله ماي فاتورة؛ يستبعد
# مسبار هذا الفحص والأجسام الفارغة من التقرير فقط، لا أكثر.
MF_GENUINE="gateway = 'myfatoorah' and raw_payload ? 'Data'"

# يعيد نتيجة الاستعلام على stdout وكود الخروج الحقيقي لـ psql. المستدعي يفحص
# الكود حتى يميّز "لا صفوف" عن "فشل الاستعلام" — الأخير فشل صلب، لأن قاعدة
# بيانات لا يمكن الوصول إليها لا يجوز أن تُخفي أحدث نداء مرفوض. (الفحص في
# المستدعي لا هنا: الدالة تعمل داخل $(…) أي في subshell لا يرى المتغيرات.)
db_query() {
  docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -Atc "$1" 2>&1
}

DB_OK=1
NEWEST="$(db_query "select signature_valid::text || '|' || coalesce(event_type, '?') || '|' || received_at::text from public.webhook_events where $MF_GENUINE order by received_at desc limit 1")" \
  || { DB_OK=0; fail "webhook_events query failed: $(echo "$NEWEST" | head -1)"; }

if [ "$DB_OK" -eq 1 ]; then
  if [ -z "$NEWEST" ]; then
    warn "webhook_events has no genuine myfatoorah callback yet — none has ever been received"
  else
    SIG_VALID="${NEWEST%%|*}"
    REST="${NEWEST#*|}"
    EVENT_TYPE="${REST%%|*}"
    EVENT_TIME="${REST#*|}"
    case "$EVENT_TYPE" in
      PAYMENT_STATUS_CHANGED|REFUND_STATUS_CHANGED|BALANCE_TRANSFERRED) VERIFIABLE=1 ;;
      *) VERIFIABLE=0 ;;
    esac
    if [ "$SIG_VALID" = "true" ]; then
      pass "newest myfatoorah callback ($EVENT_TYPE, $EVENT_TIME) has a valid signature"
    elif [ "$VERIFIABLE" -eq 1 ]; then
      warn "newest gateway-shaped callback ($EVENT_TYPE, $EVENT_TIME) was rejected — if MyFatoorah really sent it, the live HMAC secret does not match; an unsigned row cannot be authenticated, so confirm against the portal's webhook log"
    else
      warn "newest gateway-shaped callback ($EVENT_TYPE, $EVENT_TIME) was rejected; that event type has no canonical field order (unsupported_event_type), so this says nothing about the secret"
    fi
  fi
fi

# أحدث حدث صحيح التوقيع وعمره الزمني (معلوماتي).
if [ "$DB_OK" -eq 1 ]; then
  LATEST_VALID_EVENT="$(db_query "select coalesce(max(received_at)::text, 'none') from public.webhook_events where $MF_GENUINE and signature_valid = true")" \
    || { DB_OK=0; fail "webhook_events query failed: $(echo "$LATEST_VALID_EVENT" | head -1)"; }
fi
if [ "$DB_OK" -eq 1 ] && [ "$LATEST_VALID_EVENT" != "none" ]; then
  AGE_DAYS="$(db_query "select extract(day from now() - max(received_at)) from public.webhook_events where $MF_GENUINE and signature_valid = true")" \
    || { DB_OK=0; fail "webhook_events query failed: $(echo "$AGE_DAYS" | head -1)"; }
fi
SECRET_PROVEN=0
if [ "$DB_OK" -eq 1 ] && [ "$LATEST_VALID_EVENT" != "none" ]; then
  pass "latest valid webhook event: $LATEST_VALID_EVENT (age: ${AGE_DAYS%.*} days)"
  # أثناء التحديث المتدرج في Swarm تبقى الحاوية القديمة تخدم لحظات بعد بدء
  # الجديدة (13 ثانية في نشر 2026-09-07)، فنداء وصل في تلك الفترة ربما وثّقته
  # القديمة بسرّها. لذلك يُؤخذ الأحدث من: بدء الحاوية الحالية، وإيقاف آخر مهمة
  # سابقة (Swarm يحفظ تاريخ المهام). المقارنة في Postgres لا في bash: طابعا
  # الوقت بصيغتين مختلفتين، ومقارنة النصوص تخطئ عند اختلاف عدد خانات الكسور.
  CONTAINER_STARTED="$(docker inspect -f '{{.State.StartedAt}}' "$APP_CONTAINER" 2>/dev/null)"
  SERVICE_NAME="${APP_CONTAINER%%.*}"
  PREVIOUS_SHUTDOWN="$(for t in $(docker service ps "$SERVICE_NAME" -q 2>/dev/null); do
    docker inspect -f '{{.DesiredState}} {{.Status.Timestamp.UTC.Format "2006-01-02T15:04:05.000000000Z07:00"}}' "$t" 2>/dev/null
  done | awk '$1 != "running" {print $2}' | sort | tail -1)"
  PROOF_INFO="$(db_query "select case when '${PREVIOUS_SHUTDOWN:-$CONTAINER_STARTED}'::timestamptz > '${CONTAINER_STARTED}'::timestamptz then '${PREVIOUS_SHUTDOWN}' || '|the previous container shut down' else '${CONTAINER_STARTED}' || '|this container started' end")" \
    || { DB_OK=0; fail "webhook_events query failed: $(echo "$PROOF_INFO" | head -1)"; }
  PROOF_AFTER="${PROOF_INFO%%|*}"
  PROOF_WHY="${PROOF_INFO#*|}"
  PROVEN="false"
  if [ "$DB_OK" -eq 1 ]; then
    PROVEN="$(db_query "select (max(received_at) >= '${PROOF_AFTER}'::timestamptz)::text from public.webhook_events where $MF_GENUINE and signature_valid = true")" \
      || { DB_OK=0; fail "webhook_events query failed: $(echo "$PROVEN" | head -1)"; }
  fi
  if [ "$DB_OK" -eq 1 ] && [ "$PROVEN" = "true" ]; then
    SECRET_PROVEN=1
    pass "a signature-valid callback arrived after $PROOF_WHY ($PROOF_AFTER) — only the current container could have validated it; the configured HMAC secret is proven"
  elif [ "$DB_OK" -eq 1 ]; then
    warn "no signature-valid callback since $PROOF_WHY ($PROOF_AFTER) — the configured HMAC secret is not yet proven; the first live payment must produce a signature_valid=true row within SECONDS"
  fi
elif [ "$DB_OK" -eq 1 ]; then
  warn "no signature-valid callback has ever been received — the configured HMAC secret is not yet proven"
fi

# --- النتيجة النهائية -------------------------------------------------------
# ثلاث نتائج لا اثنتان: فشل صلب (1)، أو كل الفحوص المباشرة سليمة لكن السرّ لم
# يُثبَت بعد بنداء موقّع (2)، أو مُثبَت (0). الخلط بين الأخيرتين هو ما يجعل
# "verified" تُقال قبل أول دفعة حقيقية.
echo "----------------------------------------------------------------"
if [ "$HARD_FAIL" -ne 0 ]; then
  echo "RESULT: ${HARD_FAIL} hard failure(s) — cutover NOT complete"
  exit 1
elif [ "$SECRET_PROVEN" -eq 1 ]; then
  echo "RESULT: LIVE configuration verified (0 hard failures; webhook secret proven by a signed callback)"
  exit 0
else
  echo "RESULT: UNVERIFIED — direct checks passed, but no signed callback since the current container took over; make one live payment and re-run"
  exit 2
fi
