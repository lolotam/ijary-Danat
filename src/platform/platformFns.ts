import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import { parseServerInput } from "@/lib/parseServerInput";
import {
  createCompanySchema,
  listCompaniesSchema,
  platformCreateCompany,
  platformGetCompany,
  platformListCompanies,
  platformUpdateCompany,
  updateCompanySchema,
} from "@/platform/companies";
import { companyStatusSchema, platformSetCompanyStatus } from "@/platform/companyStatus";
import {
  platformCreateUser,
  platformListUsers,
  platformResetPassword,
  platformSetUserActive,
  type PlatformStaffRole,
} from "@/platform/users";

/**
 * أغلفة دوال الخادم لعمليات لوحة المنصة، مع ما يستدعيها منها المتصفح.
 *
 * The operations themselves live in `companies.ts`, `users.ts` and
 * `companyStatus.ts` and are plain async functions; this file is the seam
 * between them and the browser. Each wrapper validates its input with the
 * schema that describes the contract, so a request that carries garbage is
 * refused before it reaches a write.
 *
 * The browser-side functions exist because the platform guard reads the
 * caller's bearer token from the request headers, and the browser's Supabase
 * session lives in local storage rather than in a cookie: the token has to
 * travel with the call, or the guard sees a request with no caller at all.
 *
 * The refusal codes the server raises are turned into sentences here, so no
 * screen has to know how a refusal is spelled.
 */

/**
 * رمز رفض الطلب الذي لا يحمل جلسة مشرف منصة.
 *
 * The code is the one the platform guard raises (`PLATFORM_ADMIN_REQUIRED` in
 * `requirePlatformAdmin.server.ts`), spelled out here because that module
 * reaches for the request-only API, and importing it would drag that API
 * into the browser bundle — where the build refuses it.
 */
const NO_PLATFORM_SESSION = "PLATFORM_ADMIN_REQUIRED";

/**
 * أدوار موظف الشركة كما يقبلها مشرف المنصة.
 *
 * The list is pinned to `PlatformStaffRole` so a role added to the domain
 * contract cannot be accepted here and refused there.
 */
const staffRoleSchema = z.enum([
  "admin",
  "accountant",
  "collector",
  "readonly",
] as const satisfies readonly PlatformStaffRole[]);

/**
 * مخططات حسابات الشركة كما يعقدها المتصفح.
 *
 * The authoritative schemas live beside the operations in `users.ts`; these
 * mirror them so the browser contract is declared in one place. The domain
 * function still validates every call, so a caller that reaches it by another
 * road gets the same refusal.
 */
const listCompanyUsersSchema = z.object({
  companyId: z.string().uuid(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

const createCompanyUserSchema = z.object({
  companyId: z.string().uuid(),
  fullName: z.string().trim().min(1).max(120),
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional()
    .nullable(),
  email: z.string().trim().email().max(320).optional().nullable(),
  phone: z.string().trim().max(32).optional().nullable(),
  role: staffRoleSchema,
});

const setCompanyUserActiveSchema = z.object({
  companyId: z.string().uuid(),
  userId: z.string().uuid(),
  isActive: z.boolean(),
});

const resetCompanyUserPasswordSchema = z.object({
  companyId: z.string().uuid(),
  userId: z.string().uuid(),
});

/** مخطط قراءة شركة واحدة. */
const fetchCompanySchema = z.object({ companyId: z.string().uuid() });

/** مدخل سرد الشركات كما تقبله اللوحة. */
export type ListPlatformCompaniesInput = z.input<typeof listCompaniesSchema>;

/** مدخل إنشاء شركة كما تقبله اللوحة. */
export type CreatePlatformCompanyInput = z.input<typeof createCompanySchema>;

/** مدخل تعديل شركة كما تقبله اللوحة. */
export type UpdatePlatformCompanyInput = z.input<typeof updateCompanySchema>;

/** مدخل تغيير حالة شركة كما تقبله اللوحة. */
export type SetPlatformCompanyStatusInput = z.input<typeof companyStatusSchema>;

/** مدخل سرد حسابات شركة كما تقبله اللوحة. */
export type ListPlatformCompanyUsersInput = z.input<typeof listCompanyUsersSchema>;

/** مدخل إنشاء حساب موظف كما تقبله اللوحة. */
export type CreatePlatformCompanyUserInput = z.input<typeof createCompanyUserSchema>;

/** مدخل تفعيل حساب أو إيقافه كما تقبله اللوحة. */
export type SetPlatformCompanyUserActiveInput = z.input<typeof setCompanyUserActiveSchema>;

/** مدخل إعادة تعيين كلمة مرور كما تقبله اللوحة. */
export type ResetPlatformCompanyUserPasswordInput = z.input<typeof resetCompanyUserPasswordSchema>;

/**
 * ينفّذ عملية لوحة منصة، مرفقاً بها رمز جلسة المشرف العام.
 *
 * The token is read from the browser session and travels as a bearer header,
 * because the platform guard authenticates the caller from the request and
 * the session itself is never a cookie the request would carry.
 */
async function callPlatformOperation<TOutput>(
  serverFn: (options: { data: unknown; headers: { Authorization: string } }) => Promise<TOutput>,
  input: unknown,
): Promise<TOutput> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error(NO_PLATFORM_SESSION);
  }
  return serverFn({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}

/** يسرد شركات المنصة مع حالتها وعدد حسابات كل منها. */
const listPlatformCompaniesFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(listCompaniesSchema, data))
  .handler(async ({ data }) => platformListCompanies(data));

/** يقرأ شركة واحدة بمعرّفها مع سبب إيقافها. */
const fetchPlatformCompanyFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(fetchCompanySchema, data))
  .handler(async ({ data }) => platformGetCompany(data));

/** ينشئ شركة بمديرها الأول ويعيد كلمة المرور المؤقتة. */
const createPlatformCompanyFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(createCompanySchema, data))
  .handler(async ({ data }) => platformCreateCompany(data));

/** يحدّث اسم الشركة وبيانات الاتصال بها. */
const updatePlatformCompanyFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(updateCompanySchema, data))
  .handler(async ({ data }) => platformUpdateCompany(data));

/** يوقف شركة أو يعيد تفعيلها مع تسجيل السبب. */
const setPlatformCompanyStatusFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(companyStatusSchema, data))
  .handler(async ({ data }) => platformSetCompanyStatus(data));

/** يسرد حسابات شركة معيّنة. */
const listPlatformCompanyUsersFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(listCompanyUsersSchema, data))
  .handler(async ({ data }) => platformListUsers(data));

/** ينشئ حساب موظف داخل شركة ويعيد كلمة المرور المؤقتة. */
const createPlatformCompanyUserFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(createCompanyUserSchema, data))
  .handler(async ({ data }) => platformCreateUser(data));

/** يوقف حساب موظف داخل شركة أو يعيد تفعيله. */
const setPlatformCompanyUserActiveFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(setCompanyUserActiveSchema, data))
  .handler(async ({ data }) => platformSetUserActive(data));

/** يغيّر كلمة مرور حساب موظف إلى كلمة مؤقتة. */
const resetPlatformCompanyUserPasswordFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(resetCompanyUserPasswordSchema, data))
  .handler(async ({ data }) => platformResetPassword(data));

/** يقرأ شركات المنصة من المتصفح، مع رمز الجلسة. */
export function fetchPlatformCompanies(input: ListPlatformCompaniesInput) {
  return callPlatformOperation(listPlatformCompaniesFn, input);
}

/** يقرأ شركة واحدة من المتصفح، مع رمز الجلسة. */
export function fetchPlatformCompany(input: { companyId: string }) {
  return callPlatformOperation(fetchPlatformCompanyFn, input);
}

/** ينشئ شركة من المتصفح، ويعيد كلمة المرور المؤقتة. */
export function createPlatformCompany(input: CreatePlatformCompanyInput) {
  return callPlatformOperation(createPlatformCompanyFn, input);
}

/** يحدّث شركة من المتصفح. */
export function updatePlatformCompany(input: UpdatePlatformCompanyInput) {
  return callPlatformOperation(updatePlatformCompanyFn, input);
}

/** يغيّر حالة شركة من المتصفح. */
export function setPlatformCompanyStatus(input: SetPlatformCompanyStatusInput) {
  return callPlatformOperation(setPlatformCompanyStatusFn, input);
}

/** يقرأ حسابات شركة من المتصفح. */
export function fetchPlatformCompanyUsers(input: ListPlatformCompanyUsersInput) {
  return callPlatformOperation(listPlatformCompanyUsersFn, input);
}

/** ينشئ حساب موظف من المتصفح، ويعيد كلمة المرور المؤقتة. */
export function createPlatformCompanyUser(input: CreatePlatformCompanyUserInput) {
  return callPlatformOperation(createPlatformCompanyUserFn, input);
}

/** يوقف حساب موظف أو يعيد تفعيله من المتصفح. */
export function setPlatformCompanyUserActive(input: SetPlatformCompanyUserActiveInput) {
  return callPlatformOperation(setPlatformCompanyUserActiveFn, input);
}

/** يعيد تعيين كلمة مرور حساب موظف من المتصفح. */
export function resetPlatformCompanyUserPassword(input: ResetPlatformCompanyUserPasswordInput) {
  return callPlatformOperation(resetPlatformCompanyUserPasswordFn, input);
}

/**
 * يحوّل خطأ عملية المنصة إلى رسالة مترجمة.
 *
 * The server carries one bare code per refusal reason — `SLUG_TAKEN`,
 * `USER_NOT_FOUND` — and the panel turns that code into the sentence the super
 * admin reads. Any other message is a real failure, and it gets the generic
 * sentence rather than a raw key on screen.
 */
export function platformErrorMessage(t: (key: string) => string, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  if (!/^[A-Z][A-Z_]*$/.test(message)) {
    return t("platformCompaniesUi.error.generic");
  }
  const key = `platformCompanies.error.${message}`;
  const translated = t(key);
  return translated === key ? t("platformCompaniesUi.error.generic") : translated;
}
