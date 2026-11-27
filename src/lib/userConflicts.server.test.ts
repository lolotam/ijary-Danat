import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; display_name: string | null }>,
  queries: [] as Array<{ companyId: string | null; eqs: string[][]; excludes: string[] }>,
}));

vi.mock("@/company/companyClient.server", () => ({
  serverCompanyClient: (companyId?: string | null) => {
    const query = { companyId: companyId ?? null, eqs: [] as string[][], excludes: [] as string[] };
    mocks.queries.push(query);
    return {
      companyId: companyId ?? "11111111-1111-4111-8111-111111111111",
      client: {
        from: () => ({
          select: () => {
            const chain: Record<string, unknown> = {
              eq: (column: string, value: string) => {
                query.eqs.push([column, value]);
                return chain;
              },
              neq: (column: string, value: string) => {
                query.excludes.push(`${column}=${value}`);
                return chain;
              },
              limit: async () => ({ data: mocks.rows, error: null }),
            };
            return chain;
          },
        }),
      },
    };
  },
}));

import {
  assertUsernameAvailable,
  emailTakenError,
  isEmailConflict,
  isUsernameConflict,
} from "./userConflicts.server";

describe("isUsernameConflict", () => {
  // The matcher has to know the per-company constraint (migration 255) by name:
  // a duplicate username in ANOTHER company no longer violates anything, so the
  // constraint that fires is always the caller's own company's.
  it.each([
    ['duplicate key value violates unique constraint "profiles_company_username_key"', true],
    ['duplicate key value violates unique constraint "profiles_username_key"', true],
    ['duplicate key value violates unique constraint "profiles_company_email_lower_idx"', false],
    ['duplicate key value violates unique constraint "profiles_company_tenant_id_unique"', false],
    ["connection refused", false],
  ])("%s -> %s", (message, expected) => {
    expect(isUsernameConflict({ code: "23505", message })).toBe(expected);
  });

  it("never matches without a unique violation on profiles", () => {
    expect(isUsernameConflict({ code: "23503", message: "profiles_company_username_key" })).toBe(
      false,
    );
    expect(isUsernameConflict(null)).toBe(false);
    expect(isUsernameConflict({ code: "23505" })).toBe(false);
  });
});

describe("isEmailConflict", () => {
  it.each([
    ['duplicate key value violates unique constraint "profiles_company_email_lower_idx"', true],
    ['duplicate key value violates unique constraint "profiles_company_username_key"', false],
    ['duplicate key value violates unique constraint "profiles_username_key"', false],
    ["connection refused", false],
  ])("%s -> %s", (message, expected) => {
    expect(isEmailConflict({ code: "23505", message })).toBe(expected);
  });

  it("never matches without a unique violation on profiles", () => {
    expect(isEmailConflict({ code: "23503", message: "profiles_company_email_lower_idx" })).toBe(
      false,
    );
    expect(isEmailConflict({ code: "23505" })).toBe(false);
  });
});

describe("assertUsernameAvailable", () => {
  beforeEach(() => {
    mocks.rows = [];
    mocks.queries = [];
  });

  it("checks within the company and excludes the account being edited", async () => {
    await assertUsernameAvailable(
      "faisal",
      "own-profile-id",
      "22222222-2222-2222-2222-222222222222",
    );

    expect(mocks.queries[0].companyId).toBe("22222222-2222-2222-2222-222222222222");
    expect(mocks.queries[0].eqs).toContainEqual([
      "company_id",
      "22222222-2222-2222-2222-222222222222",
    ]);
    expect(mocks.queries[0].eqs).toContainEqual(["username", "faisal"]);
    expect(mocks.queries[0].excludes).toContain("id=own-profile-id");
  });

  it("names the owner when the name is taken inside the company", async () => {
    mocks.rows = [{ id: "other", display_name: "Faisal" }];

    await expect(assertUsernameAvailable("faisal", null)).rejects.toThrow(
      'The username "faisal" is already used by "Faisal".',
    );
  });

  it("passes when no account in the company holds the name", async () => {
    await expect(assertUsernameAvailable("faisal", null)).resolves.toBeUndefined();
  });
});

describe("emailTakenError", () => {
  beforeEach(() => {
    mocks.rows = [];
    mocks.queries = [];
  });

  it("scopes the owner lookup to the company and names the owner", async () => {
    mocks.rows = [{ id: "other", display_name: "Faisal" }];

    const error = await emailTakenError("a@b.test", "22222222-2222-2222-2222-222222222222");

    expect(mocks.queries[0].companyId).toBe("22222222-2222-2222-2222-222222222222");
    expect(mocks.queries[0].eqs).toContainEqual(["email", "a@b.test"]);
    expect(error.message).toContain('The email "a@b.test" is already used by "Faisal".');
  });

  it("still yields the conflict when no owner can be read", async () => {
    const error = await emailTakenError("a@b.test");

    expect(error.message).toContain("already registered to another account");
  });
});
