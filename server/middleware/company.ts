import {
  extractRequestHost,
  resolveHostCompany,
  type HostLookupDeps,
} from "@/company/hostCompany.server";
import { runWithHostContext } from "@/company/requestCompany.server";

/**
 * وسيطة الطلبات التي تحسم الشركة من ترويسة المضيف وتحقنها في سياق التنفيذ طوال مدة الطلب.
 *
 * Host-based route gating (`/platform/*`, `/admin/*`, 404) and suspended-company
 * rendering attach here in their dedicated tasks (T081, T121); Phase 2 establishes
 * the host resolution and AsyncLocalStorage request context without blocking routes yet.
 */
export async function withCompanyContext(
  request: Request,
  next: () => Promise<Response> | Response,
  deps?: HostLookupDeps,
): Promise<Response> {
  const host = extractRequestHost(request);
  const resolution = await resolveHostCompany(host, deps);
  return runWithHostContext(resolution, () => next());
}
