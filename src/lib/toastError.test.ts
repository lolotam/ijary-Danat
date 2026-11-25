import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

import { toast } from "sonner";
import { describeError, showError } from "./toastError";

describe("describeError", () => {
  it("returns undefined for null/undefined/empty", () => {
    expect(describeError(undefined)).toBeUndefined();
    expect(describeError(null)).toBeUndefined();
    expect(describeError("")).toBeUndefined();
  });

  it("returns the message of an Error instance", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("returns a plain string unchanged", () => {
    expect(describeError("something went wrong")).toBe("something went wrong");
  });

  it("prefixes a Supabase PostgrestError-shaped object with its code", () => {
    const postgrestError = {
      name: "PostgrestError",
      code: "PGRST204",
      message: "Could not find the 'portal_tab_dashboard' column",
      details: null,
      hint: null,
    };
    // PostgrestError is NOT an Error instance — this is the regression this
    // helper exists to prevent.
    expect(postgrestError instanceof Error).toBe(false);
    expect(describeError(postgrestError)).toBe(
      "[PGRST204] Could not find the 'portal_tab_dashboard' column",
    );
  });

  it("returns the message alone when code is absent", () => {
    expect(describeError({ message: "network failed" })).toBe("network failed");
  });

  it("falls back to hint when message is absent", () => {
    expect(describeError({ hint: "try again later" })).toBe("try again later");
  });

  it("returns undefined for an object with no recognised field", () => {
    expect(describeError({ unrelated: 42 })).toBeUndefined();
  });
});

describe("showError", () => {
  it("logs the full error and toasts the title + description", () => {
    vi.mocked(toast.error).mockClear();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    showError("The data could not be saved.", {
      code: "PGRST204",
      message: "missing column",
    });

    expect(spy).toHaveBeenCalledWith(
      "The data could not be saved.",
      expect.objectContaining({ code: "PGRST204", message: "missing column" }),
    );
    expect(toast.error).toHaveBeenCalledWith("The data could not be saved.", {
      description: "[PGRST204] missing column",
    });

    spy.mockRestore();
  });
});
