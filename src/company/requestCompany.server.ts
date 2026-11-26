// Namespace import, read only at call time: some `src/fns` modules still reach
// the browser graph, and Vite's browser stub throws on any eager named import.
import * as asyncHooks from "node:async_hooks";
import type { AsyncLocalStorage } from "node:async_hooks";

import { CompanyContextError } from "@/company/errors";
import type { CompanyStatus } from "@/integrations/supabase/database.types";

/**
 * بيانات الشركة المرتبطة بالطلب الحالي على الخادم.
 */
export interface RequestCompany {
  id: string;
  slug: string;
  status: CompanyStatus;
  host: string;
}

export type HostKind = "platform_root" | "platform_admin" | "company" | "unknown";

export type HostResolution =
  | { kind: "platform_root" | "platform_admin" | "unknown"; host: string; company: null }
  | { kind: "company"; host: string; company: RequestCompany };

interface RequestHostStore {
  hostResolution: HostResolution;
}

const REQUEST_COMPANY_STORAGE_KEY = Symbol.for("ijary:request-company-storage");

/**
 * يُعيد مخزن AsyncLocalStorage المشترك على مستوى العملية لسياق الشركة لكل طلب.
 *
 * Stored on `globalThis` via `Symbol.for` so Vite SSR and bundled server chunks
 * never split into two separate AsyncLocalStorage instances.
 */
function getRequestHostStorage(): AsyncLocalStorage<RequestHostStore> {
  const globalObj = globalThis as Record<PropertyKey, unknown>;
  if (!globalObj[REQUEST_COMPANY_STORAGE_KEY]) {
    globalObj[REQUEST_COMPANY_STORAGE_KEY] = new asyncHooks.AsyncLocalStorage<RequestHostStore>();
  }
  return globalObj[REQUEST_COMPANY_STORAGE_KEY] as AsyncLocalStorage<RequestHostStore>;
}

/**
 * ينفّذ دالةً ضمن سياق المضيف والشركة المحسومين للطلب الحالي.
 */
export function runWithHostContext<T>(resolution: HostResolution, fn: () => T): T {
  return getRequestHostStorage().run({ hostResolution: resolution }, fn);
}

/**
 * ينفّذ دالةً ضمن سياق شركة محددة (أو من دون شركة)، مفيد للمهام والاختبارات.
 */
export function runWithRequestCompany<T>(company: RequestCompany | null, fn: () => T): T {
  const resolution: HostResolution = company
    ? { kind: "company", host: company.host, company }
    : { kind: "unknown", host: "", company: null };
  return runWithHostContext(resolution, fn);
}

/**
 * يُعيد نتيجة حسم المضيف الكاملة للطلب الحالي، أو null خارج نطاق الطلب.
 */
export function getRequestHostResolution(): HostResolution | null {
  return getRequestHostStorage().getStore()?.hostResolution ?? null;
}

/**
 * يُعيد الشركة المرتبطة بالطلب الحالي، أو null إذا كان الطلب للمنصة أو لمضيف غير معروف.
 */
export function getRequestCompany(): RequestCompany | null {
  return getRequestHostStorage().getStore()?.hostResolution.company ?? null;
}

/**
 * يُعيد الشركة المرتبطة بالطلب الحالي، ويرمي خطأ COMPANY_REQUIRED عند غيابها.
 */
export function requireRequestCompany(): RequestCompany {
  const company = getRequestCompany();
  if (!company) {
    throw new CompanyContextError("COMPANY_REQUIRED");
  }
  return company;
}
