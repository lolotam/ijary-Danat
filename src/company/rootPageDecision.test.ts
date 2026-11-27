import { describe, expect, test } from "vitest";

import type { HostResolution } from "@/company/requestCompany.server";
import { decideRootPage } from "@/company/rootPageDecision";

const COMPANY_HOST: HostResolution = {
  kind: "company",
  host: "acme.ijary.app",
  company: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "acme",
    status: "active",
    host: "acme.ijary.app",
  },
};
const PLATFORM_ROOT: HostResolution = { kind: "platform_root", host: "ijary.app", company: null };
const ADMIN_HOST: HostResolution = {
  kind: "platform_admin",
  host: "admin.ijary.app",
  company: null,
};
const UNKNOWN_HOST: HostResolution = { kind: "unknown", host: "", company: null };

describe("decideRootPage answers what each host shows at /", () => {
  test.each([
    ["the platform root serves the temporary platform page", PLATFORM_ROOT, false, "platform"],
    [
      "the platform root shows no company landing page even with the section on",
      PLATFORM_ROOT,
      true,
      "platform",
    ],
    [
      "the super admin host stands on the temporary page until its panel entry exists",
      ADMIN_HOST,
      false,
      "platform",
    ],
    [
      "a company root goes to sign-in while its landing section is off",
      COMPANY_HOST,
      false,
      "signIn",
    ],
    [
      "a company root serves its landing page when the section is on",
      COMPANY_HOST,
      true,
      "landing",
    ],
    ["an unknown host resolves to the not-found page", UNKNOWN_HOST, false, "notFound"],
  ] as const)("%s", (_scenario, resolution, landingPage, expectedPage) => {
    expect(decideRootPage(resolution, { landingPage })).toEqual({ page: expectedPage });
  });
});
