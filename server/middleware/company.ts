import {
  extractRequestHost,
  resolveHostCompany,
  type HostLookupDeps,
} from "@/company/hostCompany.server";
import { runWithHostContext } from "@/company/requestCompany.server";
import { isRouteAllowedForHost } from "@/company/routeGating";

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
 * وسيطة الطلبات التي تحسم الشركة من ترويسة المضيف وتحقنها في سياق التنفيذ طوال مدة الطلب،
 * وتقفل المسارات على مضيفاتها الصحيحة بصفحة 404 قبل التنفيذ.
 *
 * Host-based route gating (T081): `/platform/*` runs on the admin host only,
 * `/admin/*` and `/portal/*` on company hosts only, and an unknown host gets
 * 404 everywhere except the public webhook routes. Suspended-company rendering
 * attaches here in its dedicated task (T121).
 */
export async function withCompanyContext(
  request: Request,
  next: () => Promise<Response> | Response,
  deps?: HostLookupDeps,
): Promise<Response> {
  const host = extractRequestHost(request);
  const resolution = await resolveHostCompany(host, deps);
  if (!isRouteAllowedForHost(resolution, new URL(request.url).pathname)) {
    return hostNotFoundResponse();
  }
  return runWithHostContext(resolution, () => next());
}
