import { describe, expect, test } from "vitest";

import { selectEligibleTemplates } from "@/hooks/useTenantEligibleTemplates";

const workflows = [
  { key: "contract-expiry", recipient_targets: ["admin", "company", "tenant"] },
  { key: "payment-succeeded", recipient_targets: ["admin", "company", "tenant"] },
];

const row = (over: Partial<Record<string, unknown>>) =>
  ({
    id: "x",
    code: "receipt",
    type: "receipt",
    channel: "email",
    is_active: true,
    ...over,
  }) as never;

describe("selectEligibleTemplates", () => {
  test("keeps an offerable template", () => {
    expect(selectEligibleTemplates([row({})], workflows, "email")).toHaveLength(1);
  });

  test("drops an inactive template", () => {
    expect(selectEligibleTemplates([row({ is_active: false })], workflows, "email")).toHaveLength(
      0,
    );
  });

  test("drops a staff-only type", () => {
    const staff = row({ code: "payment-admin-alert", type: "payment_admin_alert" });
    expect(selectEligibleTemplates([staff], workflows, "email")).toHaveLength(0);
  });

  // Direction matters both ways.
  test("a 'both' template matches a specific channel", () => {
    expect(selectEligibleTemplates([row({ channel: "both" })], workflows, "email")).toHaveLength(1);
  });

  test("an email-only template does NOT match a requested 'both'", () => {
    expect(selectEligibleTemplates([row({ channel: "email" })], workflows, "both")).toHaveLength(0);
  });

  test("drops the template once the tenant pill is removed", () => {
    const expiry = row({ code: "contract-expiry", type: "contract_expiry" });
    const without = [{ key: "contract-expiry", recipient_targets: ["admin"] }];
    expect(selectEligibleTemplates([expiry], workflows, "email")).toHaveLength(1);
    expect(selectEligibleTemplates([expiry], without, "email")).toHaveLength(0);
  });
});
