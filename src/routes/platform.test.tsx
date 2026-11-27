/**
 * @vitest-environment jsdom
 *
 * سلوك لوحة المشرف العام: البوابة، الدخول، العامل الثاني، وسجل التدقيق.
 *
 * Supabase and the router are system boundaries; the guard decision, forms,
 * table and pagination under test are the real modules. Nothing internal is
 * mocked, so a wrong navigation target or a missing challenge id fails here.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no media-query API; the real sidebar asks for it on mount.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const state = vi.hoisted(() => ({
  auth: {
    user: null as { id: string } | null,
    loading: false,
    signOut: vi.fn(async () => undefined),
  },
  navigate: vi.fn(),
  pathname: "/platform",
  aal: { currentLevel: "aal1", nextLevel: "aal1" } as {
    currentLevel: string | null;
    nextLevel: string | null;
  },
  signIn: vi.fn(),
  rpc: vi.fn(),
  listFactors: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
  audit: {
    table: "",
    filters: [] as Array<[string, unknown, unknown]>,
    range: [] as number[],
    result: { data: [] as unknown[], error: null as { message: string } | null, count: 0 },
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: unknown) => options,
    Outlet: () => <div data-testid="outlet" />,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
    useNavigate: () => state.navigate,
    useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
      select({ location: { pathname: state.pathname } }),
  };
});

vi.mock("@/auth/AuthProvider", () => ({ useAuth: () => state.auth }));

vi.mock("@/i18n/provider", () => {
  const value = {
    t: (key: string) => key,
    dir: "rtl",
    locale: "ar",
    toggle: vi.fn(),
    setLocale: vi.fn(),
  };
  return { useI18n: () => value, useOptionalI18n: () => value };
});

vi.mock("@/integrations/supabase/client", () => {
  const auditBuilder = {
    select() {
      return auditBuilder;
    },
    eq(column: string, value: unknown) {
      state.audit.filters.push(["eq", column, value]);
      return auditBuilder;
    },
    like(column: string, value: unknown) {
      state.audit.filters.push(["like", column, value]);
      return auditBuilder;
    },
    order() {
      return auditBuilder;
    },
    async range(from: number, to: number) {
      state.audit.range = [from, to];
      return state.audit.result;
    },
  };

  return {
    supabase: {
      auth: {
        signInWithPassword: (args: unknown) => state.signIn(args),
        signOut: () => state.auth.signOut(),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({ data: state.aal, error: null }),
          listFactors: () => state.listFactors(),
          enroll: (args: unknown) => state.enroll(args),
          unenroll: (args: unknown) => state.unenroll(args),
          challenge: (args: unknown) => state.challenge(args),
          verify: (args: unknown) => state.verify(args),
        },
      },
      rpc: async (name: string, args: unknown) => ({
        data: await state.rpc(name, args),
        error: null,
      }),
      from(table: string) {
        state.audit.table = table;
        return auditBuilder;
      },
    },
  };
});

const { ThemeProvider } = await import("@/components/ThemeProvider");
const { PlatformLayout, resolvePlatformAccess } = await import("@/routes/platform");
const { PlatformLoginPage } = await import("@/routes/platform.login");
const { PlatformMfaPage } = await import("@/routes/platform.mfa");
const { PlatformAuditPage } = await import("@/routes/platform.audit");
const { AuditTable } = await import("@/components/platform/AuditTable");

let container: HTMLDivElement;
let root: Root;

/** يركّب مكوّناً داخل حاوية jsdom نظيفة. */
function mount(ui: ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ThemeProvider>{ui}</ThemeProvider>));
}

/** ينتظر انتهاء الوعود التي أطلقها المكوّن بعد التركيب أو التفاعل. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  });
}

/** يكتب قيمة في حقل React بالطريقة التي يلتقطها authoritative change event. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** يقدّم النموذج ويانتظر معالج الإرسال. */
async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

/** يضغط زراً بمفتاح ترجمته المعروض في الاختبار. */
async function clickButton(text: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(text),
  );
  expect(button, `button ${text}`).toBeDefined();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

/** يعيد صف تدقيق ثابتاً للعرض والاختبار. */
function auditRow() {
  return {
    id: "row-1",
    actor_id: "admin-1",
    company_id: "company-1",
    action: "company.create",
    entity: "company",
    entity_id: "company-1",
    before: null,
    after: { name: "Acme" },
    ip: null,
    request_id: null,
    created_at: "2026-11-27T10:00:00Z",
  };
}

/** يعيد قائمة عوامل فارغة بالشكل الذي يعيده Supabase. */
function noFactors() {
  return { data: { all: [], totp: [], phone: [], webauthn: [], recovery_code: [] }, error: null };
}

/** يعيد عاملاً TOTOP مؤكداً للاختبار. */
function verifiedFactor() {
  const factor = {
    id: "factor-1",
    factor_type: "totp",
    friendly_name: "Authenticator",
    status: "verified",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  };
  return {
    data: {
      all: [factor],
      totp: [factor],
      phone: [],
      webauthn: [],
      recovery_code: [],
    },
    error: null,
  };
}

beforeEach(() => {
  state.auth.user = null;
  state.auth.loading = false;
  state.auth.signOut.mockReset();
  state.auth.signOut.mockResolvedValue(undefined);
  state.navigate.mockReset();
  state.pathname = "/platform";
  state.aal = { currentLevel: "aal1", nextLevel: "aal1" };
  state.signIn.mockReset();
  state.rpc.mockReset();
  state.rpc.mockResolvedValue(true);
  state.listFactors.mockReset();
  state.enroll.mockReset();
  state.unenroll.mockReset();
  state.challenge.mockReset();
  state.verify.mockReset();
  state.audit.filters = [];
  state.audit.range = [];
  state.audit.result = { data: [], error: null, count: 0 };
});

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("platform gate decision", () => {
  it.each([
    {
      scenario: "the session is still loading",
      input: { loading: true, hasUser: false, aal2: false, isAdmin: false },
      expected: "loading",
    },
    {
      scenario: "there is no signed-in user",
      input: { loading: false, hasUser: false, aal2: false, isAdmin: false },
      expected: "login",
    },
    {
      scenario: "an admin reached aal2",
      input: { loading: false, hasUser: true, aal2: true, isAdmin: true },
      expected: "ready",
    },
    {
      scenario: "an admin signed in with only a password",
      input: { loading: false, hasUser: true, aal2: false, isAdmin: true },
      expected: "mfa",
    },
    {
      scenario: "a staff account without a second factor cannot be identified yet",
      input: { loading: false, hasUser: true, aal2: false, isAdmin: false },
      expected: "mfa",
    },
    {
      scenario: "a staff account even has a second factor",
      input: { loading: false, hasUser: true, aal2: true, isAdmin: false },
      expected: "denied",
    },
  ])("$scenario -> $expected", ({ input, expected }) => {
    expect(resolvePlatformAccess(input)).toBe(expected);
  });
});

describe("platform sign-in", () => {
  it("sends a one-factor admin to second-factor setup", async () => {
    state.signIn.mockResolvedValue({ data: { session: {} }, error: null });
    mount(<PlatformLoginPage />);
    typeInto(
      container.querySelector<HTMLInputElement>("#platform-login-email")!,
      "admin@ijary.app",
    );
    typeInto(
      container.querySelector<HTMLInputElement>("#platform-login-password")!,
      "long-password",
    );

    await submit(container.querySelector("form")!);
    await settle();

    expect(state.signIn).toHaveBeenCalledWith({
      email: "admin@ijary.app",
      password: "long-password",
    });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.navigate).toHaveBeenCalledWith({ to: "/platform/mfa" });
    expect(state.auth.signOut).not.toHaveBeenCalled();
  });

  it("sends an admin who already has aal2 straight to the panel", async () => {
    state.aal = { currentLevel: "aal2", nextLevel: "aal2" };
    state.signIn.mockResolvedValue({ data: { session: {} }, error: null });
    mount(<PlatformLoginPage />);
    typeInto(
      container.querySelector<HTMLInputElement>("#platform-login-email")!,
      "admin@ijary.app",
    );
    typeInto(
      container.querySelector<HTMLInputElement>("#platform-login-password")!,
      "long-password",
    );

    await submit(container.querySelector("form")!);
    await settle();

    expect(state.navigate).toHaveBeenCalledWith({ to: "/platform" });
  });

  it("shows one generic refusal for invalid credentials", async () => {
    state.signIn.mockResolvedValue({
      data: { session: null },
      error: { message: "invalid login credentials" },
    });
    mount(<PlatformLoginPage />);
    typeInto(
      container.querySelector<HTMLInputElement>("#platform-login-email")!,
      "admin@ijary.app",
    );
    typeInto(
      container.querySelector<HTMLInputElement>("#platform-login-password")!,
      "wrong-password",
    );

    await submit(container.querySelector("form")!);
    await settle();

    expect(container.textContent).toContain("platform.login.error.invalid");
    expect(state.navigate).not.toHaveBeenCalled();
  });
});

describe("platform second factor", () => {
  it("renders the second-factor page instead of a loading screen", async () => {
    state.auth.user = { id: "admin-1" };
    state.pathname = "/platform/mfa";

    mount(<PlatformLayout />);
    await settle();

    expect(container.querySelector("[data-testid=outlet]")).not.toBeNull();
    expect(state.navigate).not.toHaveBeenCalledWith({ to: "/platform/mfa" });
  });

  it("enrols a TOTP factor when none is verified, then verifies the first code", async () => {
    state.auth.user = { id: "admin-1" };
    state.listFactors.mockResolvedValue(noFactors());
    state.enroll.mockResolvedValue({
      data: {
        id: "factor-1",
        type: "totp",
        totp: { qr_code: "data:image/svg+xml,qr", secret: "BASE32SECRET", uri: "otpauth://x" },
      },
      error: null,
    });
    state.challenge.mockResolvedValue({ data: { id: "challenge-1" }, error: null });
    state.verify.mockResolvedValue({ data: { session: {} }, error: null });

    mount(<PlatformMfaPage />);
    await settle();

    expect(state.enroll).toHaveBeenCalledWith({ factorType: "totp", friendlyName: "IJARY" });
    expect(container.textContent).toContain("BASE32SECRET");

    typeInto(container.querySelector<HTMLInputElement>("#platform-mfa-code")!, "123456");
    await submit(container.querySelector("form")!);
    await settle();

    expect(state.challenge).toHaveBeenCalledWith({ factorId: "factor-1" });
    expect(state.verify).toHaveBeenCalledWith({
      factorId: "factor-1",
      challengeId: "challenge-1",
      code: "123456",
    });
    expect(state.navigate).toHaveBeenCalledWith({ to: "/platform" });
  });

  it("challenges an existing verified factor without enrolling another", async () => {
    state.auth.user = { id: "admin-1" };
    state.listFactors.mockResolvedValue(verifiedFactor());
    state.challenge.mockResolvedValue({ data: { id: "challenge-2" }, error: null });
    state.verify.mockResolvedValue({ data: { session: {} }, error: null });

    mount(<PlatformMfaPage />);
    await settle();

    expect(state.enroll).not.toHaveBeenCalled();
    typeInto(container.querySelector<HTMLInputElement>("#platform-mfa-code")!, "654321");
    await submit(container.querySelector("form")!);
    await settle();

    expect(state.challenge).toHaveBeenCalledWith({ factorId: "factor-1" });
    expect(state.navigate).toHaveBeenCalledWith({ to: "/platform" });
  });

  it("rejects a code that is not six digits before calling Supabase", async () => {
    state.auth.user = { id: "admin-1" };
    state.listFactors.mockResolvedValue(verifiedFactor());

    mount(<PlatformMfaPage />);
    await settle();
    typeInto(container.querySelector<HTMLInputElement>("#platform-mfa-code")!, "abc");
    await submit(container.querySelector("form")!);
    await settle();

    expect(state.challenge).not.toHaveBeenCalled();
    expect(container.textContent).toContain("platform.mfa.error.code");
  });
});

describe("platform audit screen", () => {
  it("renders real audit rows in a table", () => {
    mount(<AuditTable rows={[auditRow()]} loading={false} error={null} />);
    expect(container.textContent).toContain("company.create");
    expect(container.textContent).toContain("admin-1");
    expect(container.textContent).toContain("2026-11-27T10:00:00Z");
  });

  it("loads the first page on mount and the next page on demand", async () => {
    state.audit.result = { data: [auditRow()], error: null, count: 30 };
    mount(<PlatformAuditPage />);
    await settle();

    expect(state.audit.table).toBe("platform_audit_log");
    expect(state.audit.range).toEqual([0, 24]);
    expect(container.textContent).toContain("company.create");

    await clickButton("platform.audit.next");
    await settle();
    expect(state.audit.range).toEqual([25, 49]);
  });
});
