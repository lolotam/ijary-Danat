import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", async () =>
  (await import("./signInWithIdentifier.testkit")).serverFnModule(),
);
vi.mock("@supabase/supabase-js", async () =>
  (await import("./signInWithIdentifier.testkit")).supabaseJsModule(),
);
vi.mock("@/company/companyClient.server", async () =>
  (await import("./signInWithIdentifier.testkit")).companyClientModule(),
);
vi.mock("@/company/requestCompany.server", async () =>
  (await import("./signInWithIdentifier.testkit")).requestCompanyModule(),
);
vi.mock("@/fns/loginAudit", async () =>
  (await import("./signInWithIdentifier.testkit")).loginAuditModule(),
);

import type { RequestCompany } from "@/company/requestCompany.server";
import { signInWithIdentifier } from "./signInWithIdentifier";
import {
  resetSignInFixtures,
  serverFunction,
  signInBoundary,
  signInState,
} from "./signInWithIdentifier.testkit";

// The mocked createServerFn returns a plain callable, so the exported symbol's
// fetcher type does not describe how it is driven here.
const signIn = signInWithIdentifier as unknown as typeof serverFunction;

const SUSPENDED_COMPANY: RequestCompany = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  slug: "frozen",
  status: "suspended",
  host: "frozen.ijary.app",
};

describe("signInWithIdentifier on a suspended company (T121)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    resetSignInFixtures();
    signInState.requestCompany = SUSPENDED_COMPANY;
  });

  it("refuses the sign-in with COMPANY_SUSPENDED", async () => {
    const result = await signIn({ identifier: "owner", password: "pw" });

    expect(result).toEqual({ ok: false, error: "COMPANY_SUSPENDED" });
  });

  it("checks the status before the password, so no credential is tried", async () => {
    // The status is public through the host: the visitor is already on the
    // page that says the account is paused, so the refusal costs nothing and
    // says nothing the visitor does not know.
    await signIn({ identifier: "owner", password: "pw" });

    expect(signInBoundary.signInWithPassword).not.toHaveBeenCalled();
  });
});
