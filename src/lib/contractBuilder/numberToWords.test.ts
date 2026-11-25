import { describe, expect, test } from "vitest";

import {
  amountInWordsAr,
  amountInWordsEn,
  dayNameAr,
  dayNameEn,
  durationWordsAr,
  durationWordsEn,
  isRealCalendarDate,
} from "./numberToWords";

describe("amountInWordsAr / amountInWordsEn", () => {
  test.each([
    [0, "صفر دينار كويتي", "zero Kuwaiti dinars"],
    [1000, "دينار كويتي واحد", "one Kuwaiti dinar"],
    [2000, "ديناران كويتيان", "two Kuwaiti dinars"],
    [3000, "ثلاثة دنانير كويتية", "three Kuwaiti dinars"],
    [11000, "أحد عشر ديناراً كويتياً", "eleven Kuwaiti dinars"],
    [2_500_000, "ألفان وخمسمائة دينار كويتي", "two thousand five hundred Kuwaiti dinars"],
    [30_000_000, "ثلاثون ألف دينار كويتي", "thirty thousand Kuwaiti dinars"],
    [
      1_250_500,
      "ألف ومائتان وخمسون ديناراً كويتياً وخمسمائة فلس",
      "one thousand two hundred fifty Kuwaiti dinars and five hundred fils",
    ],
  ] as const)("fils %s", (fils, ar, en) => {
    expect(amountInWordsAr(fils)).toBe(ar);
    expect(amountInWordsEn(fils)).toBe(en);
  });

  // 999_999_000 fils = 999,999 KWD. The plan table wrote "million"; the fils
  // integer is nine hundred ninety-nine thousand dinars, matching the grammar
  // table (words from the whole-dinar count, not the raw fils figure).
  test("999_999_000 fils names the hundred-thousands band", () => {
    expect(amountInWordsAr(999_999_000)).toMatch(/^تسعمائة وتسعة وتسعون ألف/);
    expect(amountInWordsEn(999_999_000)).toMatch(/^nine hundred ninety-nine thousand/);
  });
});

describe("durationWordsAr / durationWordsEn", () => {
  test.each([
    [1, "شهر واحد", "one month"],
    [2, "شهران", "two months"],
    [3, "ثلاثة أشهر", "three months"],
    [11, "أحد عشر شهراً", "eleven months"],
    [12, "سنة واحدة", "one year"],
    [13, "ثلاثة عشر شهراً", "thirteen months"],
    [24, "سنتان", "two years"],
    [36, "ثلاث سنوات", "three years"],
  ] as const)("%s months", (months, ar, en) => {
    expect(durationWordsAr(months)).toBe(ar);
    expect(durationWordsEn(months)).toBe(en);
  });
});

describe("day names (Asia/Kuwait)", () => {
  test("2026-09-15 is Tuesday in both locales", () => {
    expect(dayNameAr("2026-09-15")).toBe("الثلاثاء");
    expect(dayNameEn("2026-09-15")).toBe("Tuesday");
  });
});

describe("isRealCalendarDate", () => {
  test("rejects impossible calendar days", () => {
    expect(isRealCalendarDate("2026-02-30")).toBe(false);
    expect(isRealCalendarDate("2026-13-01")).toBe(false);
    expect(isRealCalendarDate("2026-02-29")).toBe(false);
  });

  test("accepts a real leap day", () => {
    expect(isRealCalendarDate("2024-02-29")).toBe(true);
  });
});
