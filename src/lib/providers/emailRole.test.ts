import { describe, expect, it } from "vitest";

import { emailRolePromotionTarget } from "./emailRole";

describe("emailRolePromotionTarget", () => {
  it.each([
    ["making a card the default promotes that card", "resend", "primary", "resend"],
    ["making a card the fallback promotes the other card", "resend", "fallback", "smtp"],
    ["the swap works from the SMTP side too", "smtp", "fallback", "resend"],
  ] as const)("%s", (_scenario, cardId, role, expected) => {
    expect(emailRolePromotionTarget(["resend", "smtp"], cardId, role)).toBe(expected);
  });

  it("promotes nothing when the only email provider is set to fallback", () => {
    expect(emailRolePromotionTarget(["resend"], "resend", "fallback")).toBeNull();
  });
});
