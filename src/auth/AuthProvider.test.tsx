/**
 * @vitest-environment jsdom
 *
 * The deactivated-account rejection is only real if it never reaches the
 * direct client-side sign-in below it — falling through would authenticate
 * against `<username>@users.local` and let the account straight in. The other
 * two cases pin the opposite: every other outcome (a thrown resolver error,
 * ordinary bad credentials) must KEEP falling through, because that fallback
 * is what keeps a resolver outage from locking everyone out.
 *
 * Same jsdom + createRoot technique as GalleryTable.test.tsx — this repo has
 * no @testing-library, and none is needed to click one button.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolver: vi.fn(),
  directSignIn: vi.fn(),
  // The host company read and the profile company read behind the post-sign-in
  // membership check (AuthProvider's "counts as not signed in" rule).
  requestCompanyIdFn: vi.fn(),
  profileRow: { company_id: "company-a" } as { company_id: string } | null,
  setSession: vi.fn().mockResolvedValue({ error: null }),
  signOut: vi.fn().mockResolvedValue(undefined),
  // One object, like the real hook: usePostHog returns the same client on
  // every render. It keeps the identified ID the way PostHog's own storage
  // does, because the provider reads that persisted state back.
  posthog: (() => {
    const state = { identifiedId: null as string | null };
    return {
      state,
      identify: vi.fn((id: string) => {
        state.identifiedId = id;
      }),
      reset: vi.fn(() => {
        state.identifiedId = null;
      }),
      _isIdentified: () => state.identifiedId !== null,
      get_distinct_id: () => state.identifiedId ?? "anonymous-device-id",
    };
  })(),
  initialSession: null as null | { user: { id: string } },
  authListener: null as null | ((event: string, session: unknown) => void),
}));

vi.mock("@/fns/signInWithIdentifier", () => ({
  signInWithIdentifier: (args: unknown) => mocks.resolver(args),
  getPublicRequestCompanyId: () => mocks.requestCompanyIdFn(),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => mocks.posthog,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: mocks.initialSession } }),
      onAuthStateChange: (listener: (event: string, session: unknown) => void) => {
        mocks.authListener = listener;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      setSession: mocks.setSession,
      signInWithPassword: (args: unknown) => mocks.directSignIn(args),
      signOut: mocks.signOut,
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: mocks.profileRow, error: null }),
        }),
      }),
    }),
  },
}));

import { AuthProvider, useAuth } from "@/auth/AuthProvider";

// No @testing-library here: React's act() needs this flag to know it runs in
// a test environment, otherwise every call logs a warning (harmless but noisy).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** الخطأ الذي أعادته محاولة الدخول، أو undefined ما لم تكتمل بعد. */
let reported: string | null | undefined;

/**
 * زرّ يمرّر محاولة الدخول عبر المزوّد ويسجّل الخطأ العائد منه.
 */
function Harness() {
  const { signInWithPassword } = useAuth();
  return (
    <button
      type="button"
      onClick={() => {
        // The rejection path records too. `signInWithPassword` is contracted to
        // resolve with an error string rather than throw, so a rejection here is
        // itself the bug — and without this branch it would surface as the test
        // hanging until timeout instead of as a readable failure.
        void signInWithPassword("someone", "pw")
          .then(({ error }) => {
            reported = error;
          })
          .catch((error: unknown) => {
            reported = error instanceof Error ? error.message : String(error);
          });
      }}
    >
      go
    </button>
  );
}

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

/**
 * يركّب المزوّد ومعه الزرّ في جذر React حي.
 */
function mountProvider() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );
  });
  roots.push({ root, container });
}

/**
 * يضغط الزرّ وينتظر اكتمال الوعد حتى يُسجَّل الخطأ.
 */
async function clickGo() {
  reported = undefined;
  const button = document.querySelector("button");
  expect(button, "the harness button should render").toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  while (reported === undefined) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return reported;
}

afterEach(() => {
  while (roots.length) {
    const { root, container } = roots.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

describe("the direct sign-in fallback", () => {
  beforeEach(() => {
    mocks.resolver.mockReset();
    mocks.directSignIn.mockReset();
    mocks.directSignIn.mockResolvedValue({ error: null });
  });

  test("is not reached when the account is deactivated", async () => {
    mocks.resolver.mockResolvedValue({ ok: false, error: "ACCOUNT_DEACTIVATED" });

    mountProvider();
    const error = await clickGo();

    // The whole point: falling through here would sign the user in anyway via
    // the legacy <username>@users.local mapping.
    expect(error).toBe("ACCOUNT_DEACTIVATED");
    expect(mocks.directSignIn).not.toHaveBeenCalled();
  });

  test("is not reached when the company is suspended", async () => {
    mocks.resolver.mockResolvedValue({ ok: false, error: "COMPANY_SUSPENDED" });

    mountProvider();
    const error = await clickGo();

    expect(error).toBe("COMPANY_SUSPENDED");
    expect(mocks.directSignIn).not.toHaveBeenCalled();
  });

  test("is still reached when the resolver throws", async () => {
    // The warn is the fallback doing its documented job; silence it so the
    // suite output stays readable.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.resolver.mockRejectedValue(new Error("offline"));

    mountProvider();
    await clickGo();

    expect(mocks.directSignIn).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  test("is still reached on ordinary bad credentials", async () => {
    mocks.resolver.mockResolvedValue({ ok: false, error: "INVALID_CREDENTIALS" });

    mountProvider();
    await clickGo();

    expect(mocks.directSignIn).toHaveBeenCalledTimes(1);
  });
});

/**
 * يثبت قاعدة «حساب من شركة أخرى يُعدَّ غير مسجَّل الدخول» بعد أي مصادقة ناجحة.
 *
 * Both sign-in paths are covered because both can end in a session: the
 * resolver's tokens, and the direct fallback's — the fallback in particular can
 * authenticate another company's account, since GoTrue spans companies.
 */
describe("company membership after sign-in", () => {
  beforeEach(() => {
    mocks.resolver.mockReset();
    mocks.directSignIn.mockReset();
    mocks.requestCompanyIdFn.mockReset().mockResolvedValue("company-a");
    mocks.setSession.mockReset().mockResolvedValue({ error: null });
    mocks.signOut.mockReset().mockResolvedValue(undefined);
    mocks.profileRow = { company_id: "company-a" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** يشغّل مسار الدخول الاحتياطي بجلسة حساب محددة. */
  function stageFallbackSession(userId: string) {
    mocks.resolver.mockRejectedValue(new Error("offline"));
    mocks.directSignIn.mockResolvedValue({
      data: { session: { user: { id: userId } } },
      error: null,
    });
  }

  test("a fallback sign-in of another company's account is not signed in", async () => {
    stageFallbackSession("user-b");
    mocks.profileRow = { company_id: "company-b" };

    mountProvider();
    const error = await clickGo();

    // Same wording as a wrong password: no hint that the account exists on
    // another company's address.
    expect(error).toBe("Invalid login credentials");
    expect(mocks.signOut).toHaveBeenCalled();
  });

  test("a fallback sign-in of this company's account stays signed in", async () => {
    stageFallbackSession("user-a");

    mountProvider();
    const error = await clickGo();

    expect(error).toBeNull();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  test("a resolver sign-in whose session belongs to another company is not signed in", async () => {
    mocks.resolver.mockResolvedValue({ ok: true, accessToken: "a", refreshToken: "r" });
    mocks.setSession.mockResolvedValue({
      data: { session: { user: { id: "user-b" } } },
      error: null,
    });
    mocks.profileRow = { company_id: "company-b" };

    mountProvider();
    const error = await clickGo();

    expect(error).toBe("Invalid login credentials");
    expect(mocks.signOut).toHaveBeenCalled();
  });

  test("a session with no profile visible in this company is not signed in", async () => {
    stageFallbackSession("user-b");
    mocks.profileRow = null;

    mountProvider();
    const error = await clickGo();

    expect(error).toBe("Invalid login credentials");
    expect(mocks.signOut).toHaveBeenCalled();
  });

  test("a host with no company refuses the session", async () => {
    // The server refuses every call from such a host (`requireSupabaseAuth`),
    // so letting the shell render a session there would be a dead end anyway.
    stageFallbackSession("user-a");
    mocks.requestCompanyIdFn.mockResolvedValue(null);

    mountProvider();
    const error = await clickGo();

    expect(error).toBe("Invalid login credentials");
    expect(mocks.signOut).toHaveBeenCalled();
  });

  test("a check that cannot run keeps the session, so an outage cannot lock anyone out", async () => {
    stageFallbackSession("user-a");
    mocks.requestCompanyIdFn.mockRejectedValue(new Error("offline"));

    mountProvider();
    const error = await clickGo();

    expect(error).toBeNull();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});

/**
 * يبثّ حدث مصادقة من Supabase كأنه وصل من الخادم.
 */
function emitSession(userId: string | null) {
  act(() => {
    mocks.authListener!(
      userId ? "SIGNED_IN" : "SIGNED_OUT",
      userId ? { user: { id: userId } } : null,
    );
  });
}

/**
 * يركّب المزوّد وينتظر حتى تُحسم الجلسة الأولى من getSession.
 */
async function mountResolvedProvider() {
  mountProvider();
  await act(async () => {
    await Promise.resolve();
  });
}

describe("the PostHog identity", () => {
  beforeEach(() => {
    mocks.posthog.state.identifiedId = null;
    mocks.initialSession = null;
    mocks.posthog.identify.mockClear();
    mocks.posthog.reset.mockClear();
  });

  test("is the Supabase user ID alone, with no email or name attached", async () => {
    await mountResolvedProvider();
    emitSession("user-a");

    // Tenants are real people and PostHog is a third party.
    expect(mocks.posthog.identify).toHaveBeenCalledTimes(1);
    expect(mocks.posthog.identify).toHaveBeenCalledWith("user-a");
  });

  test("is dropped before a different account is identified", async () => {
    await mountResolvedProvider();
    emitSession("user-a");
    emitSession("user-b");

    // Without the reset, user-b's events would merge into user-a's person.
    expect(mocks.posthog.reset).toHaveBeenCalledTimes(1);
    expect(mocks.posthog.identify).toHaveBeenLastCalledWith("user-b");
    expect(mocks.posthog.reset.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.posthog.identify.mock.invocationCallOrder[1],
    );
  });

  test("is reset when the session ends", async () => {
    await mountResolvedProvider();
    emitSession("user-a");
    emitSession(null);

    expect(mocks.posthog.state.identifiedId).toBeNull();
  });

  // PR #256 review: a session that expired while the tab was closed left the
  // previous user's ID in PostHog's storage, and a fresh mount never cleared it.
  test("left over from an expired session is cleared on a signed-out startup", async () => {
    mocks.posthog.state.identifiedId = "user-from-last-visit";

    await mountResolvedProvider();

    expect(mocks.posthog.reset).toHaveBeenCalledTimes(1);
    expect(mocks.posthog.state.identifiedId).toBeNull();
  });

  test("restored with a live session is kept, not reset and re-identified", async () => {
    mocks.posthog.state.identifiedId = "user-a";
    mocks.initialSession = { user: { id: "user-a" } };

    await mountResolvedProvider();

    expect(mocks.posthog.reset).not.toHaveBeenCalled();
    expect(mocks.posthog.identify).not.toHaveBeenCalled();
  });
});
