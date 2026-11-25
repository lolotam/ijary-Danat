import { describe, expect, it } from "vitest";

import { authErrorMessage } from "./authErrorMessage";

describe("authErrorMessage", () => {
  it("keeps GoTrue's own text when it is present", () => {
    expect(
      authErrorMessage(
        { message: "A user with this email address has already been registered", status: 422 },
        "Failed to create auth user",
      ),
    ).toBe("A user with this email address has already been registered");
  });

  it("replaces the '{}' auth-js produces for a 5xx with the status", () => {
    // Regression, 2026-08-16: the admin Users screen showed a red `{}` toast on
    // every password change for an account GoTrue could not load. This is
    // exactly the error auth-js 2.111 returned for that 500.
    expect(authErrorMessage({ message: "{}", status: 500 }, "Failed to update user")).toBe(
      "Failed to update user (auth service returned HTTP 500)",
    );
  });

  it("falls back to the caller's text when there is neither message nor status", () => {
    expect(authErrorMessage({ message: "  ", status: undefined }, "Failed to update user")).toBe(
      "Failed to update user",
    );
  });
});
