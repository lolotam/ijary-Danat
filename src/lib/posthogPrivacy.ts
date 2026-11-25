import type { BeforeSendFn, CapturedNetworkRequest, Properties } from "posthog-js";

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Gateway payment-request references and other opaque keys: no route name in
// this app contains a digit, so a digit-bearing segment of 6+ chars is an ID.
const OPAQUE_ID_SEGMENT = /^(?=.*\d)[\w.-]{6,}$/;
// $current_url, $pathname, $referrer and their $initial_* person-property twins.
const URL_PROPERTY_KEY = /url|pathname|referrer/i;
const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:\/\//i;
const PLACEHOLDER_ORIGIN = "http://placeholder.invalid";

/**
 * يجرّد الرابط من كل ما قد يعرّف مستأجرًا أو دفعة: الاستعلام والمرساة ومقاطع المعرّفات.
 *
 * The query string goes whole (`/portal?tenant=…&contract=…`, the payment
 * callback's `paymentId`), as does the hash (Supabase recovery links carry
 * `#access_token=…`). ID-shaped path segments (`/admin/tenants/<uuid>`,
 * `/portal/payments/callback/<preq>`) become `:id`, so pages still group by
 * route. Values that are neither absolute URLs nor paths — PostHog's
 * `$direct` referrer sentinel — are returned as they are. An absolute URL that
 * does not parse is dropped rather than passed through: failing closed is the
 * point of this function.
 */
export function redactUrl(value: string): string {
  const isAbsolute = ABSOLUTE_URL.test(value);
  if (!isAbsolute && !value.startsWith("/")) return value;

  let parsed: URL;
  try {
    parsed = new URL(value, PLACEHOLDER_ORIGIN);
  } catch (error) {
    if (error instanceof TypeError) return "";
    throw error;
  }

  const path = parsed.pathname
    .split("/")
    .map((segment) =>
      UUID_SEGMENT.test(segment) || OPAQUE_ID_SEGMENT.test(segment) ? ":id" : segment,
    )
    .join("/");
  return isAbsolute ? `${parsed.origin}${path}` : path;
}

/**
 * يطبّق redactUrl على كل خاصية رابط في مجموعة خصائص، بما فيها الكائنات المتداخلة.
 *
 * Nested objects matter: `$web_vitals` copies the raw page URL into
 * `$web_vitals_<metric>_event.navigationURL` and `.$current_url`, and PostHog's
 * own web-vitals masking only knows query-parameter names, not path IDs.
 */
function redactUrlProperties(properties: Properties): Properties {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, redactPropertyValue(key, value)]),
  );
}

/**
 * ينظّف قيمة خاصية واحدة: الرابط يُجرَّد، والكائن والمصفوفة يُفحصان بداخلهما، والباقي يمرّ.
 */
function redactPropertyValue(key: string, value: unknown): unknown {
  if (typeof value === "string") return URL_PROPERTY_KEY.test(key) ? redactUrl(value) : value;
  // Web-vitals `entries` arrays hold objects too: an LCP entry's `url` can be a
  // signed Storage link carrying its token in the query (Codex review, PR #257).
  if (Array.isArray(value)) return value.map((item) => redactPropertyValue(key, item));
  if (value && typeof value === "object") return redactUrlProperties(value as Properties);
  return value;
}

/**
 * خطّاف before_send لـ PostHog: ينظّف روابط كل حدث قبل أن يغادر المتصفح.
 *
 * `autocapture: false` stops element text, but automatic `$pageview` events
 * still carry the full URL, and PostHog copies the first one into the person
 * profile via `$set_once` ($initial_current_url). All three bags are cleaned.
 *
 * `$snapshot` (session replay) passes through untouched: walking a full DOM
 * snapshot on every flush is expensive, and replay routes every URL it
 * records through `redactReplayRequestUrl` instead.
 */
export const redactEventUrls: BeforeSendFn = (event) => {
  if (!event || event.event === "$snapshot") return event;
  return {
    ...event,
    properties: redactUrlProperties(event.properties),
    ...(event.$set ? { $set: redactUrlProperties(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: redactUrlProperties(event.$set_once) } : {}),
  };
};

/**
 * خطّاف session_recording.maskCapturedNetworkRequestFn: يجرّد روابط التسجيل.
 *
 * posthog-js sends the replay's page URL, its `$url_changed` and `$pageview`
 * markers, and every recorded network request through this one function —
 * which also covers PostgREST calls like `?tenant_id=eq.<uuid>` in the
 * replay's network tab.
 */
export function redactReplayRequestUrl(request: CapturedNetworkRequest): CapturedNetworkRequest {
  return { ...request, name: redactUrl(request.name) };
}
