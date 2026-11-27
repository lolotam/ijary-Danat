// عميل Cloudflare for SaaS: ينشئ اسم مضيف مخصّصاً ويقرأ حالته.
//
// نقطتان فقط هما ما يحتاجه تدفّق النطاقات المخصّصة. المسارات وأسماء الحقول
// قُرئت من مرجع واجهة Cloudflare بتاريخ 2026-11-27:
//   - `POST /zones/{zone_id}/custom_hostnames` ينشئ المضيف ويعيد `result.id`
//     و`result.status` و`result.ownership_verification` (تحدّ TXT) و
//     `result.ownership_verification_http` (تحدّ HTTP).
//   - `GET /zones/{zone_id}/custom_hostnames/{id}` يعيد الصورة نفسها مع
//     `result.verification_errors` و`result.ssl.status`.
// الرمز يحتاج صلاحية "SSL and Certificates Write" على منطقة المنصة.
import { readCloudflareConfig } from "@/lib/env.server";

/** عنوان واجهة Cloudflare. */
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * سجلات إثبات الملكية التي يعيدها Cloudflare لنطاق مخصّص.
 *
 * The domain owner publishes one of these in DNS; the panel shows it so the
 * super admin can tell the company exactly what to add. Declared as a type
 * alias rather than an interface so it keeps the implicit index signature
 * `Json` needs when the column is stored as `jsonb`.
 */
export type CustomHostnameVerification = {
  /** تحدّ TXT: الاسم والقيمة اللذين يضعان في DNS. */
  txt: { name: string; type: "txt"; value: string } | null;
  /** تحدّ HTTP إن اختاره Cloudflare بدل TXT. */
  http: { url: string; body: string } | null;
  /** الهدف الذي يجب أن يشير إليه CNAME. */
  cnameTarget: string;
  /** أخطاء التفعيل التي أعادها Cloudflare. */
  errors: string[];
};

/** اسم مضيف مخصّص كما تراه Cloudflare. */
export interface CloudflareCustomHostname {
  /** معرّف المضيف عند Cloudflare، يُخزَّن في `company_domains.provider_ref`. */
  id: string;
  hostname: string;
  /** حالة التفعيل: `active` أو `pending` أو `blocked` وغيرها. */
  status: string;
  /** حالة شهادة TLS، أو `null` إن لم تكن هناك شهادة بعد. */
  sslStatus: string | null;
  verification: CustomHostnameVerification;
}

/** جواب Cloudflare الخام لنطاق مخصّص. */
interface CloudflareHostnameResult {
  id: string;
  hostname: string;
  status: string;
  custom_origin_server?: string | null;
  ownership_verification?: { name?: string | null; value?: string | null } | null;
  ownership_verification_http?: { http_url?: string | null; http_body?: string | null } | null;
  ssl?: { status?: string | null } | null;
  verification_errors?: string[] | null;
}

/**
 * يقرأ رمز Cloudflare ومعرّف المنطقة، ويرفض العمل إن غابا.
 *
 * The pair is optional until the owner turns the custom-domain flow on, so the
 * message names the two variables instead of failing later with an opaque
 * HTTP error from the provider.
 */
function requireCloudflareConfig(): { apiToken: string; zoneId: string } {
  const config = readCloudflareConfig();
  if (!config) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID must be set before custom domains can be managed",
    );
  }
  return config;
}

/**
 * يرسل طلباً إلى Cloudflare ويعيد نتيجة نجاحه.
 *
 * A Cloudflare failure is never silent: the provider's own error messages
 * travel in the thrown error, because "the domain did not save" without the
 * reason leaves the super admin guessing.
 */
async function callCloudflare<T>(path: string, init: RequestInit): Promise<T> {
  const { apiToken } = requireCloudflareConfig();
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  const body = (await response.json()) as {
    success?: boolean;
    result?: T;
    errors?: Array<{ message?: string }>;
  };
  if (!response.ok || body.success !== true || body.result === undefined) {
    const detail =
      body.errors
        ?.map((entry) => entry.message)
        .filter((message): message is string => Boolean(message))
        .join("; ") || response.statusText;
    throw new Error(`Cloudflare custom hostname request failed: ${detail}`);
  }
  return body.result;
}

/**
 * يحوّل جواب Cloudflare الخام إلى صورة النطاق، ويفصل سجلات إثبات الملكية.
 */
function toCustomHostname(result: CloudflareHostnameResult): CloudflareCustomHostname {
  const ownership = result.ownership_verification;
  const httpChallenge = result.ownership_verification_http;
  return {
    id: result.id,
    hostname: result.hostname,
    status: result.status,
    sslStatus: result.ssl?.status ?? null,
    verification: {
      txt:
        ownership?.name && ownership.value
          ? { name: ownership.name, type: "txt", value: ownership.value }
          : null,
      http: httpChallenge?.http_url
        ? { url: httpChallenge.http_url, body: httpChallenge.http_body ?? "" }
        : null,
      cnameTarget: result.custom_origin_server ?? "",
      errors: result.verification_errors ?? [],
    },
  };
}

/**
 * ينشئ اسم مضيف مخصّصاً في منطقة المنصة ويقرأ تحدّ إثبات الملكية.
 *
 * Validation is by TXT record: the domain owner publishes it in their own DNS,
 * which is the only step they can do themselves. The HTTP challenge would ask
 * them to serve a file from a domain that already points at us.
 */
export async function createCloudflareCustomHostname(
  host: string,
): Promise<CloudflareCustomHostname> {
  const { zoneId } = requireCloudflareConfig();
  const result = await callCloudflare<CloudflareHostnameResult>(
    `/zones/${zoneId}/custom_hostnames`,
    {
      method: "POST",
      body: JSON.stringify({
        hostname: host,
        ssl: { method: "txt", type: "dv" },
      }),
    },
  );
  return toCustomHostname(result);
}

/**
 * يقرأ حالة اسم مضيف مخصّص من Cloudflare.
 */
export async function readCloudflareCustomHostname(
  providerRef: string,
): Promise<CloudflareCustomHostname> {
  const { zoneId } = requireCloudflareConfig();
  const result = await callCloudflare<CloudflareHostnameResult>(
    `/zones/${zoneId}/custom_hostnames/${encodeURIComponent(providerRef)}`,
    { method: "GET" },
  );
  return toCustomHostname(result);
}
