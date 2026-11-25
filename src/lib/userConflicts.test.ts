import { describe, expect, it } from "vitest";

import { t as translate } from "@/i18n/dictionary";
import { describeUserError, parseUserConflict, userConflictMessage } from "./userConflicts";

/**
 * يترجم المفتاح من الكتالوج العربي الحقيقي.
 *
 * The real dictionary, not a stub, so a missing or reworded key fails here.
 */
const ar = (key: string) => translate("ar", key);

/** يترجم المفتاح من الكتالوج الإنجليزي الحقيقي. */
const en = (key: string) => translate("en", key);

describe("describeUserError", () => {
  /**
   * Regression, 2026-09-28: a duplicate username reached the admin as the raw
   * `profiles_username_key` violation, in English, naming neither the value
   * nor what to change.
   */
  it("names the clashing username, its owner and the fix in the admin's language", () => {
    const message = userConflictMessage(
      { kind: "username", value: "faisal", owner: "فيصل" },
      'The username "faisal" is already used by "فيصل".',
    );

    expect(describeUserError(message, ar)).toBe(
      "اسم المستخدم «faisal» مستخدم مسبقاً للحساب «فيصل». يرجى اختيار اسم مستخدم آخر لحفظ هذا المستخدم.",
    );
    expect(describeUserError(message, en)).toBe(
      'The username "faisal" is already used by "فيصل". Please choose another username to save this user.',
    );
  });

  it.each([
    [{ kind: "username", value: "faisal" }, "اسم المستخدم «faisal» مستخدم مسبقاً."],
    [{ kind: "email", value: "a@b.com" }, "البريد الإلكتروني «a@b.com» مسجّل مسبقاً لحساب آخر."],
    [
      { kind: "phone-account", value: "67768068", owner: "Ali" },
      "رقم الهاتف «67768068» مستخدم مسبقاً للحساب «Ali».",
    ],
    [
      { kind: "phone-tenant", value: "67768068", owner: "شركة الخليج" },
      "رقم الهاتف «67768068» مسجّل مسبقاً للمستأجر «شركة الخليج».",
    ],
  ] as const)("fills %o into its own Arabic message", (conflict, opening) => {
    const text = describeUserError(userConflictMessage(conflict, "english"), ar);

    expect(text.startsWith(opening)).toBe(true);
    expect(text).not.toMatch(/\{value\}|\{owner\}|users\.conflict/);
  });

  // Names are free text; `$&`, `$'` or a literal "{owner}" must be shown as typed.
  it("inserts a value or owner containing $ replacement tokens literally", () => {
    const message = userConflictMessage(
      { kind: "phone-account", value: "{owner}$'67768068", owner: "A $& B" },
      "english",
    );

    expect(describeUserError(message, ar)).toContain(
      "«{owner}$'67768068» مستخدم مسبقاً للحساب «A $& B»",
    );
  });

  it("passes an untagged server error through unchanged", () => {
    expect(describeUserError("Only an admin may create a user account.", ar)).toBe(
      "Only an admin may create a user account.",
    );
  });
});

describe("parseUserConflict", () => {
  it("round-trips the conflict and keeps the English text readable after the tag", () => {
    const message = userConflictMessage({ kind: "tenant-account" }, "Tenant has an account.");

    expect(parseUserConflict(message)).toEqual({ kind: "tenant-account" });
    expect(message.endsWith("] Tenant has an account.")).toBe(true);
  });

  // Free-text names and loosely validated numbers can carry the characters
  // the tag itself is delimited by.
  it("round-trips a value and owner containing braces and the closing delimiter", () => {
    const conflict = { kind: "phone-tenant", value: "+965}51234567", owner: "Co}] {y}" } as const;

    expect(parseUserConflict(userConflictMessage(conflict, "english"))).toEqual(conflict);
  });

  it("ignores a malformed tag instead of throwing", () => {
    expect(parseUserConflict("[user-conflict:%7Bnope] text")).toBeNull();
  });
});
