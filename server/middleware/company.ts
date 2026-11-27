import {
  extractRequestHost,
  resolveHostCompany,
  type HostLookupDeps,
} from "@/company/hostCompany.server";
import { runWithHostContext, type HostResolution } from "@/company/requestCompany.server";
import {
  isRouteAllowedForHost,
  isSuspendedPagePath,
  suspendedRouteDecision,
} from "@/company/routeGating";
import { suspended as suspendedAr } from "@/i18n/locales/ar/suspended";
import { suspended as suspendedEn } from "@/i18n/locales/en/suspended";

/**
 * يبني صفحة 404 موحّدة لا تفصح عن أي شركة أو مضيف، بلا أي بيانات مشتقة من الطلب.
 */
function hostNotFoundResponse(): Response {
  return new Response(
    `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <title>404</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font: 15px/1.5 system-ui, -apple-system, sans-serif; background: #fafafa; color: #111; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 28rem; width: 100%; text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { color: #4b5563; margin: 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>404</h1>
      <p>الصفحة غير موجودة. Page not found.</p>
    </div>
  </body>
</html>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/**
 * يهرّب النص قبل وضعه في صفحة HTML، فالصفحة تُبنى بدمج النصوص لا بقالب آمن.
 *
 * The copy itself is static, but the page is assembled by concatenation, and a
 * translation that grows an ampersand or an angle bracket must not become
 * markup.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * يبني صفحة الشركة المعلّقة كوثيقة مستقلة: العربية أولاً مع سطر إنجليزي.
 *
 * The middleware can only answer with a `Response` — it cannot hand the request
 * over to the router so that `/suspended` renders — so the server needs a
 * document of its own, exactly like the 404 page above. The copy comes from
 * the locale modules directly, so the page never depends on the catalog
 * wiring, and nothing about the company is read: the page names no company at
 * all.
 */
function renderSuspendedPage(): string {
  const heading = escapeHtml(suspendedAr["suspended.heading"]);
  const body = escapeHtml(suspendedAr["suspended.body"]);
  const contact = escapeHtml(suspendedAr["suspended.contact"]);
  const title = escapeHtml(suspendedAr["suspended.title"]);
  const english = escapeHtml(suspendedEn["suspended.body"]);
  return `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font: 15px/1.6 system-ui, -apple-system, sans-serif; background: #fafafa; color: #111; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 30rem; width: 100%; text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
      p { color: #4b5563; margin: 0 0 0.75rem; }
      .en { direction: ltr; font-size: 0.875rem; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${heading}</h1>
      <p>${body}</p>
      <p>${contact}</p>
      <p class="en" dir="ltr">${english}</p>
    </div>
  </body>
</html>`;
}

/**
 * يردّ صفحة الشركة المعلّقة لطلب صفحة على مضيف شركة معلّقة.
 *
 * The status is 200 because the page is the answer, not an error report: the
 * visitor is told the account is paused and who to contact. `no-store` keeps
 * a browser or a proxy from holding a paused page after the company is
 * reactivated.
 */
function suspendedCompanyResponse(): Response {
  return new Response(renderSuspendedPage(), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * يرفض نداء واجهة أو دالة خادم لشركة معلّقة برمز `COMPANY_SUSPENDED`.
 *
 * A JSON body, not a page: the caller is a program, and the code is the
 * contract's standard refusal for a suspended company.
 */
function suspendedApiResponse(): Response {
  return new Response(JSON.stringify({ code: "COMPANY_SUSPENDED" }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * يختار سياق التنفيذ للطلب: صفحة التعليق تُقدَّم بلا شركة، وبقية الطلبات بشركتها.
 *
 * A suspended company cannot read its own data — `current_company_id()` fails
 * closed for it, and the settlement path is the only one allowed past that —
 * so the root loader's branding read would throw and the suspended page would
 * never render. The page names no company, so it is served without one.
 */
function contextForRequest(resolution: HostResolution, pathname: string): HostResolution {
  if (resolution.kind !== "company" || resolution.company.status !== "suspended") return resolution;
  if (!isSuspendedPagePath(pathname)) return resolution;
  return { kind: "unknown", host: resolution.host, company: null };
}

/**
 * وسيطة الطلبات التي تحسم الشركة من ترويسة المضيف وتحقنها في سياق التنفيذ طوال مدة الطلب،
 * وتقفل المسارات على مضيفاتها الصحيحة بصفحة 404 قبل التنفيذ.
 *
 * Host-based route gating (T081): `/platform/*` runs on the admin host only,
 * `/admin/*` and `/portal/*` on company hosts only, and an unknown host gets
 * 404 everywhere except the public webhook routes.
 *
 * A suspended company (T121) gets the suspended page for every application
 * page and `COMPANY_SUSPENDED` for every API and server-function call; the
 * suspended page itself, the public provider callbacks and the static assets
 * stay reachable.
 */
export async function withCompanyContext(
  request: Request,
  next: () => Promise<Response> | Response,
  deps?: HostLookupDeps,
): Promise<Response> {
  const host = extractRequestHost(request);
  const resolution = await resolveHostCompany(host, deps);
  const pathname = new URL(request.url).pathname;
  if (!isRouteAllowedForHost(resolution, pathname)) {
    return hostNotFoundResponse();
  }
  const suspended = suspendedRouteDecision(request, resolution, pathname);
  if (suspended === "forbidden") {
    return suspendedApiResponse();
  }
  if (suspended === "page") {
    return suspendedCompanyResponse();
  }
  return runWithHostContext(contextForRequest(resolution, pathname), () => next());
}
