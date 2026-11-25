import { describe, expect, test } from "vitest";

import { classifyIdentifier, loginIdentifierToEmail, nationalPhoneDigits } from "./loginIdentity";

describe("loginIdentifierToEmail", () => {
  test.each([
    ["admin", "admin@users.local"],
    [" Admin ", "admin@users.local"],
    ["someone@example.com", "someone@example.com"],
    ["  Someone@Example.COM ", "someone@example.com"],
  ])("%s -> %s", (input, expected) => {
    expect(loginIdentifierToEmail(input)).toBe(expected);
  });
});

describe("nationalPhoneDigits", () => {
  /*
   * The whole point of the feature. `profiles.phone` is free text, so the same
   * mobile is stored in whatever shape the person entering it preferred. Exact
   * string matching would make mobile login fail for almost everyone while
   * looking complete, so every one of these must collapse to the same value.
   */
  test.each([
    "51234567",
    "+96551234567",
    "+965 5123 4567",
    "00965-51234567",
    "965 51234567",
    "(965) 5123-4567",
  ])("%s identifies the same subscriber", (input) => {
    expect(nationalPhoneDigits(input)).toBe("51234567");
  });

  test.each([null, undefined, "", "1234567", "abc"])(
    "%s is not enough digits to identify anyone",
    (input) => {
      // Returning null rather than a short string matters: a suffix comparison
      // against "234567" would match unrelated numbers ending in those digits.
      expect(nationalPhoneDigits(input)).toBeNull();
    },
  );
});

describe("classifyIdentifier", () => {
  test.each([
    ["someone@example.com", "email"],
    ["51234567", "phone"],
    ["+965 5123 4567", "phone"],
    ["testtenant0731", "username"],
    // Usernames may contain digits; only an all-digits value is a phone attempt.
    ["user2024", "username"],
    // Too short to be a number, so it falls through to username rather than
    // being classified as a phone that can never match.
    ["12345", "username"],
  ])("%s is a %s", (input, expected) => {
    expect(classifyIdentifier(input)).toBe(expected);
  });
});
