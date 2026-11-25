/**
 * تحويل المبالغ والمدد والتواريخ إلى كلمات عربية وإنجليزية لعقد الاستثمار.
 *
 * Money is integer fils. Words are built from the whole-dinar count so a value
 * like 1250.500 cannot pick up a floating-point remainder. Kuwait has no
 * daylight saving, so the +03:00 weekday is the Asia/Kuwait calendar day.
 */

const ONES_M = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"];
const ONES_F = ["", "واحدة", "اثنتان", "ثلاث", "أربع", "خمس", "ست", "سبع", "ثمان", "تسع"];
const TEENS_M = [
  "عشرة",
  "أحد عشر",
  "اثنا عشر",
  "ثلاثة عشر",
  "أربعة عشر",
  "خمسة عشر",
  "ستة عشر",
  "سبعة عشر",
  "ثمانية عشر",
  "تسعة عشر",
];
const TEENS_F = [
  "عشر",
  "إحدى عشرة",
  "اثنتا عشرة",
  "ثلاث عشرة",
  "أربع عشرة",
  "خمس عشرة",
  "ست عشرة",
  "سبع عشرة",
  "ثماني عشرة",
  "تسع عشرة",
];
const TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
const HUNDREDS = [
  "",
  "مائة",
  "مائتان",
  "ثلاثمائة",
  "أربعمائة",
  "خمسمائة",
  "ستمائة",
  "سبعمائة",
  "ثمانمائة",
  "تسعمائة",
];

const ONES_EN = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS_EN = [
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS_EN = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

/**
 * يحوّل عدداً من 1 إلى 999 إلى كلمات عربية، مع تأنيث الآحاد عند الحاجة.
 */
function belowThousandAr(n: number, feminine = false): string {
  if (n <= 0) return "";
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const ones = feminine ? ONES_F : ONES_M;
  const teens = feminine ? TEENS_F : TEENS_M;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(HUNDREDS[hundreds]!);
  if (rest === 0) return parts.join(" و");
  if (rest < 10) parts.push(ones[rest]!);
  else if (rest < 20) parts.push(teens[rest - 10]!);
  else {
    const unit = rest % 10;
    const ten = Math.floor(rest / 10);
    if (unit === 0) parts.push(TENS[ten]!);
    else parts.push(`${ones[unit]} و${TENS[ten]}`);
  }
  return parts.join(" و");
}

type ScaleForms = { one: string; two: string; few: string; many: string };

/**
 * يركّب معدود الآلاف أو الملايين وفق جدول المثنى والجمع في المواصفة.
 */
function scalePhraseAr(count: number, forms: ScaleForms): string {
  if (count <= 0) return "";
  if (count === 1) return forms.one;
  if (count === 2) return forms.two;
  // Arabic counts the scale noun by the LAST TWO digits: 3–10 take the plural
  // (ثلاثة آلاف) and everything else the singular (مائة وواحد ألف, مائة ألف),
  // so 101 and 102 must not fall through to the plural branch.
  const lastTwo = count % 100;
  const words = belowThousandAr(count);
  if (lastTwo >= 3 && lastTwo <= 10) return `${words} ${forms.few}`;
  return `${words} ${forms.many}`;
}

/**
 * يحوّل عدداً صحيحاً (0–999,999,999) إلى كلمات عربية مفصولة بـ «و».
 */
function integerToWordsAr(n: number): string {
  if (n === 0) return "صفر";
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (millions > 0) {
    parts.push(
      scalePhraseAr(millions, { one: "مليون", two: "مليونان", few: "ملايين", many: "مليون" }),
    );
  }
  if (thousands > 0) {
    parts.push(scalePhraseAr(thousands, { one: "ألف", two: "ألفان", few: "آلاف", many: "ألف" }));
  }
  if (rest > 0) parts.push(belowThousandAr(rest));
  return parts.join(" و");
}

/**
 * يختار صيغة الدينار حسب العدد الكامل (واحد / مثنى / جمع / تمييز).
 */
function dinarPhraseAr(dinars: number): string {
  if (dinars === 0) return "صفر دينار كويتي";
  if (dinars === 1) return "دينار كويتي واحد";
  if (dinars === 2) return "ديناران كويتيان";
  const lastTwo = dinars % 100;
  const words = integerToWordsAr(dinars);
  if (lastTwo === 0) return `${words} دينار كويتي`;
  if (lastTwo >= 3 && lastTwo <= 10) return `${words} دنانير كويتية`;
  return `${words} ديناراً كويتياً`;
}

/**
 * يحوّل عدداً من 1 إلى 999 إلى كلمات إنجليزية، مع واصلة بين العشرات والآحاد.
 */
function belowThousandEn(n: number): string {
  if (n <= 0) return "";
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES_EN[hundreds]} hundred`);
  if (rest === 0) return parts.join(" ");
  if (rest < 10) parts.push(ONES_EN[rest]!);
  else if (rest < 20) parts.push(TEENS_EN[rest - 10]!);
  else {
    const unit = rest % 10;
    const ten = Math.floor(rest / 10);
    parts.push(unit === 0 ? TENS_EN[ten]! : `${TENS_EN[ten]}-${ONES_EN[unit]}`);
  }
  return parts.join(" ");
}

/**
 * يحوّل عدداً صحيحاً (0–999,999,999) إلى كلمات إنجليزية دون «and» داخل العدد.
 */
function integerToWordsEn(n: number): string {
  if (n === 0) return "zero";
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (millions === 1) parts.push("one million");
  else if (millions > 1) parts.push(`${integerToWordsEn(millions)} million`);
  if (thousands === 1) parts.push("one thousand");
  else if (thousands > 1) parts.push(`${belowThousandEn(thousands)} thousand`);
  if (rest > 0) parts.push(belowThousandEn(rest));
  return parts.join(" ");
}

/**
 * يكتب مبلغاً بالفلس كلماتٍ عربية: الدينار حسب النحو ثم الفلس إن وُجد.
 */
export function amountInWordsAr(fils: number): string {
  const dinars = Math.floor(fils / 1000);
  const remainingFils = fils % 1000;
  const core = dinarPhraseAr(dinars);
  if (remainingFils <= 0) return core;
  return `${core} و${belowThousandAr(remainingFils)} فلس`;
}

/**
 * يكتب مبلغاً بالفلس كلماتٍ إنجليزية، ويلحق الفلس بـ and.
 */
export function amountInWordsEn(fils: number): string {
  const dinars = Math.floor(fils / 1000);
  const remainingFils = fils % 1000;
  const core =
    dinars === 0
      ? "zero Kuwaiti dinars"
      : dinars === 1
        ? "one Kuwaiti dinar"
        : `${integerToWordsEn(dinars)} Kuwaiti dinars`;
  if (remainingFils <= 0) return core;
  return `${core} and ${integerToWordsEn(remainingFils)} fils`;
}

/**
 * يكتب مدة العقد بالعربية: سنوات إن انقسمت على 12، وإلا أشهراً.
 */
export function durationWordsAr(months: number): string {
  if (months > 0 && months % 12 === 0) {
    const years = months / 12;
    if (years === 1) return "سنة واحدة";
    if (years === 2) return "سنتان";
    const lastTwo = years % 100;
    if (lastTwo === 0) return `${belowThousandAr(years)} سنة`;
    if (lastTwo >= 3 && lastTwo <= 10) return `${belowThousandAr(years, true)} سنوات`;
    return `${belowThousandAr(years, true)} سنة`;
  }
  if (months === 1) return "شهر واحد";
  if (months === 2) return "شهران";
  const lastTwo = months % 100;
  if (lastTwo === 0) return `${belowThousandAr(months)} شهر`;
  if (lastTwo >= 3 && lastTwo <= 10) return `${belowThousandAr(months)} أشهر`;
  return `${belowThousandAr(months)} شهراً`;
}

/**
 * يكتب مدة العقد بالإنجليزية: years عندما تنقسم الأشهر على 12.
 */
export function durationWordsEn(months: number): string {
  if (months > 0 && months % 12 === 0) {
    const years = months / 12;
    if (years === 1) return "one year";
    if (years === 2) return "two years";
    return `${integerToWordsEn(years)} years`;
  }
  if (months === 1) return "one month";
  if (months === 2) return "two months";
  return `${integerToWordsEn(months)} months`;
}

/**
 * يتحقق أن النص تاريخ تقويمي حقيقي بنمط YYYY-MM-DD، لا مجرد تطابق أرقام.
 */
export function isRealCalendarDate(isoDate: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
  );
}

/**
 * يعيد اسم يوم الأسبوع بالعربية ليوم تقويم آسيا/الكويت.
 *
 * Kuwait has no daylight saving, so the fixed +03:00 offset is exact.
 */
export function dayNameAr(isoDate: string): string {
  return new Intl.DateTimeFormat("ar-KW", { weekday: "long", timeZone: "Asia/Kuwait" }).format(
    new Date(`${isoDate}T00:00:00+03:00`),
  );
}

/**
 * يعيد اسم يوم الأسبوع بالإنجليزية ليوم تقويم آسيا/الكويت.
 *
 * Kuwait has no daylight saving, so the fixed +03:00 offset is exact.
 */
export function dayNameEn(isoDate: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "Asia/Kuwait" }).format(
    new Date(`${isoDate}T00:00:00+03:00`),
  );
}
