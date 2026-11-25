import { describe, expect, it } from "vitest";

import { extractErrorMessage } from "./extractErrorMessage";

describe("extractErrorMessage", () => {
  it("returns the message of an Error instance", () => {
    expect(extractErrorMessage(new Error("Only an admin may update a user account."))).toBe(
      "Only an admin may update a user account.",
    );
  });

  it("returns a thrown string as-is", () => {
    expect(extractErrorMessage("Database timeout")).toBe("Database timeout");
  });

  it("reads a string message off a plain object", () => {
    expect(extractErrorMessage({ message: "Unauthorized access" })).toBe("Unauthorized access");
  });

  it("falls back for values with no readable text instead of stringifying them", () => {
    expect(extractErrorMessage({})).toBe("Unknown error");
    expect(extractErrorMessage({ message: "" }, "Failed to save")).toBe("Failed to save");
    expect(extractErrorMessage(new Error(""), "Failed to save")).toBe("Failed to save");
    // Whitespace is not a message — it would render as an empty red toast.
    expect(extractErrorMessage(new Error("   "), "Failed to save")).toBe("Failed to save");
    expect(extractErrorMessage("   ", "Failed to save")).toBe("Failed to save");
    expect(extractErrorMessage({ message: "  " }, "Failed to save")).toBe("Failed to save");
    expect(extractErrorMessage(null)).toBe("Unknown error");
    expect(extractErrorMessage(undefined, "Custom fallback")).toBe("Custom fallback");
  });
});
