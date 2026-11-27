import type { RequestCompany } from "@/company/requestCompany.server";
import { vi } from "vitest";

/**
 * عدّة اختبار لدالة الدخول بالمعرّف: حدود Supabase وGoTrue الوهمية، وحالة
 * الشركات والحسابات — تتقاسمها ملفات اختبار الدخول.
 *
 * Only system boundaries are faked here: the Supabase client (its `profiles`
 * reads stand for what RLS lets one company's client see), the GoTrue password
 * grant, and the audit writers. The identifier logic under test is real. The
 * `.testkit.ts` suffix keeps this out of the vitest include glob.
 */

/** صف profile داخل شركة واحدة كما تراه RLS لعميل تلك الشركة فقط. */
export interface ProfileRow {
  id: string;
  email: string | null;
  is_active: boolean;
}

/** الشركة التي يعيدها `requireRequestCompany` — أي مضيف الطلب الذي يجري الدخول منه. */
export const TEST_COMPANY: RequestCompany = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "danat",
  status: "active",
  host: "danat.localhost",
};

export const signInState = {
  /** الشركة الحالية التي يعيدها `requireRequestCompany`. */
  requestCompany: TEST_COMPANY as RequestCompany,
  /** صفوف profiles المرئية لكل شركة — مفتاحها معرّف الشركة (محاكاة RLS). */
  profilesByCompany: {} as Record<string, ProfileRow[]>,
  /** ردود `find_profiles_by_phone_digits` لكل شركة. */
  phoneRowsByCompany: {} as Record<string, Array<{ id: string; email: string | null }>>,
  /** نتيجة نداء GoTrue الافتراضية عندما لا يرتّب الاختبار حسابات صريحة. */
  signInResult: { data: { session: null as unknown }, error: null as unknown },
};

/** الوظائف الوهمية عند الحدود: إنشاء عميل GoTrue، الدخول، الخروج، وكتابات التدقيق. */
export const signInBoundary = {
  createClient: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  rpc: vi.fn(),
  recordLoginAttempt: vi.fn(),
  recordFailedLoginAttempt: vi.fn(),
};

/**
 * حامل دالة الخادم الوهمية: يستقبل `createServerFn` استدعاءً واحداً عند تحميل
 * الوحدة ويخزّن المعالج الحقيقي فيها، كما في اختبارات `src/fns` الأخرى.
 *
 * One harness per `createServerFn` call, because a module may export more than
 * one server function (this one exports the sign-in POST and the request
 * company GET): a shared holder would leave both exports pointing at whichever
 * handler registered last.
 */
export const serverFunction = Object.assign(
  (data: unknown) => serverFunction.handler({ data, context: serverFunction.context }),
  {
    context: null as unknown,
    handler: null as unknown as (input: { data: unknown; context: unknown }) => Promise<unknown>,
  },
);

/** مصنع `vi.mock("@tanstack/react-start", …)`. */
export function serverFnModule() {
  return {
    createServerFn: () => {
      const fn = Object.assign((data: unknown) => fn.handler({ data, context: fn.context }), {
        context: null as unknown,
        handler: null as unknown as (input: {
          data: unknown;
          context: unknown;
        }) => Promise<unknown>,
      });
      const builder = {
        handler: (handler: typeof fn.handler) => {
          fn.handler = handler;
          return fn;
        },
      };
      return {
        middleware: () => ({ inputValidator: () => builder, validator: () => builder }),
        inputValidator: () => builder,
        validator: () => builder,
        // GET functions chain `createServerFn(...).handler(...)` directly.
        handler: builder.handler,
      };
    },
    createMiddleware: () => ({ server: (handler: unknown) => handler }),
  };
}

/** مصنع `vi.mock("@supabase/supabase-js", …)`. */
export function supabaseJsModule() {
  return { createClient: signInBoundary.createClient };
}

/** مصنع `vi.mock("@/fns/loginAudit", …)`. */
export function loginAuditModule() {
  return {
    recordLoginAttempt: signInBoundary.recordLoginAttempt,
    recordFailedLoginAttempt: signInBoundary.recordFailedLoginAttempt,
  };
}

/** مصنع `vi.mock("@/company/requestCompany.server", …)`. */
export function requestCompanyModule() {
  return {
    requireRequestCompany: () => signInState.requestCompany,
    getRequestCompany: () => signInState.requestCompany,
  };
}

/**
 * مصنع `vi.mock("@/company/companyClient.server", …)`.
 *
 * Every query is answered from the rows staged for the companyId the client was
 * built for, which is what RLS guarantees for `company_service`. A sign-in that
 * resolved identifiers through the wrong company's client would see the wrong
 * rows and fail its test.
 */
export function companyClientModule() {
  return {
    companyClient: (companyId: string) => ({
      from: (_table: string) => profilesQuery(companyId),
      rpc: (name: string, args: unknown) => signInBoundary.rpc(name, args, companyId),
    }),
  };
}

/**
 * يبني مستعلم profiles وهمياً يرى صفوف صاحب العميل فقط.
 *
 * The staged rows are the lookup's answer, so `eq` values are not refiltered
 * here — exactly one staged row stands for "the database matched this
 * identifier within this company".
 */
function profilesQuery(companyId: string) {
  const rows = () => signInState.profilesByCompany[companyId] ?? [];
  return {
    select: () => ({
      eq: (_column: string, value: string) => ({
        limit: () => Promise.resolve({ data: rows() }),
        maybeSingle: () =>
          Promise.resolve({ data: rows().find((row) => row.id === value) ?? null }),
      }),
    }),
  };
}

/** يعيد الحدود والحالة إلى وضع افتراضي واحد: شركة danat وحسابها النشط. */
export function resetSignInFixtures() {
  signInState.requestCompany = TEST_COMPANY;
  signInState.profilesByCompany = {
    [TEST_COMPANY.id]: [
      { id: "11111111-1111-4111-8111-111111111111", email: "admin@example.test", is_active: true },
    ],
  };
  signInState.phoneRowsByCompany = {};
  signInState.signInResult = {
    data: {
      session: {
        access_token: "access",
        refresh_token: "refresh",
        user: { id: "11111111-1111-4111-8111-111111111111" },
      },
    },
    error: null,
  };
  signInBoundary.createClient.mockReturnValue({
    auth: {
      signInWithPassword: signInBoundary.signInWithPassword,
      signOut: signInBoundary.signOut,
    },
  });
  signInBoundary.signOut.mockResolvedValue({ error: null });
  signInBoundary.signInWithPassword.mockImplementation(() =>
    Promise.resolve(signInState.signInResult),
  );
  signInBoundary.rpc.mockImplementation((_name, _args, companyId: string) => ({
    data: signInState.phoneRowsByCompany[companyId] ?? [],
    error: null,
  }));
}

/**
 * يرتّب حدود GoTrue بحسابات لها كلمات مرور حقيقية: كل عنوان بريد بحساب واحد
 * وكلمة مرور واحدة، فتنجح محاولة الدخول بكلمة مرور الحساب صاحب البريد فقط.
 *
 * Tokens carry the account id so a test can observe *which* account signed in
 * without asserting on mock arguments.
 */
export function stageAuthAccounts(accounts: Record<string, { userId: string; password: string }>) {
  signInBoundary.signInWithPassword.mockImplementation(
    async ({ email, password }: { email: string; password: string }) => {
      const account = accounts[email];
      if (!account || account.password !== password) {
        return { data: { session: null }, error: { message: "Invalid login credentials" } };
      }
      return {
        data: {
          session: {
            access_token: `access-${account.userId}`,
            refresh_token: `refresh-${account.userId}`,
            user: { id: account.userId },
          },
        },
        error: null,
      };
    },
  );
}

/**
 * يقرأ وسائط آخر صف تدقيق كُتب لمحاولة الدخول، من أيٍّ من المسارين.
 *
 * Migration 215 routed the two attacker-reachable failures through
 * `recordFailedLoginAttempt`, which throttles before it writes and therefore
 * takes no `actorId`/`result` — those are implied by the RPC it calls. Reading
 * whichever writer fired last keeps these tests about the recorded outcome
 * rather than about which of the two functions produced it.
 */
export function lastAuditInput() {
  const throttled = signInBoundary.recordFailedLoginAttempt.mock.calls;
  if (throttled.length) {
    const input = throttled[throttled.length - 1][0] as {
      identifier: string;
      accountId: string | null;
      errorCode: string | null;
    };
    return { ...input, actorId: null, result: "failure" };
  }
  const calls = signInBoundary.recordLoginAttempt.mock.calls;
  return calls[calls.length - 1][0] as {
    identifier: string;
    accountId: string | null;
    actorId: string | null;
    result: string;
    errorCode: string | null;
  };
}
