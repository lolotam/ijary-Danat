/**
 * بيانات الطرف الأول المطبوعة على العقد: الشركة المالكة صاحبة العقد.
 *
 * The letterhead, the first-party line and the footer used to be one
 * company's hard-coded legal identity, so every company printed contracts in
 * that company's name. They now come from the company that owns the contract.
 */
export type ContractIssuer = {
  /** الاسم القانوني للشركة كما يُطبع في الترويسة وسطر الطرف الأول. */
  name: string;
  /** عنوان المقر، وقد يكون فارغاً إن لم تُدخله الشركة في إعداداتها. */
  address: string;
  /** هاتف الشركة، وقد يكون فارغاً. */
  phone: string;
  /**
   * شعار الشركة في الترويسة، أو null فلا تُطبع صورة.
   *
   * The preview carries the company's public URL; the server PDF replaces it
   * with an inlined data URI (see `readContractIssuer`). It used to be one
   * company's logo file, printed on every company's contract.
   */
  logoUrl: string | null;
};

/** حقول الشركة التي يُبنى منها الطرف الأول؛ أي صف من جدول companies يطابقها. */
export type ContractIssuerSource = {
  name_ar: string | null;
  name_en: string | null;
  address_ar: string | null;
  address_en: string | null;
  phone: string | null;
  logo_url: string | null;
};

/**
 * يرجع أول قيمة غير فارغة بعد إزالة المسافات، أو نصاً فارغاً.
 */
function firstFilled(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * يبني بيانات الطرف الأول من صف الشركة، بالعربية أولاً ثم الإنجليزية.
 *
 * Arabic first on both documents: the legal identity stays Arabic on the
 * English contract too, as the scanned originals print it. A company with no
 * row yet (still loading) gets blank fields rather than another company's.
 */
export function contractIssuerFromCompany(company: ContractIssuerSource | null): ContractIssuer {
  return {
    name: firstFilled(company?.name_ar, company?.name_en),
    address: firstFilled(company?.address_ar, company?.address_en),
    phone: firstFilled(company?.phone),
    logoUrl: webImageUrl(company?.logo_url),
  };
}

/**
 * يقبل رابط الشعار فقط إن كان http أو https، وإلا يرجع null.
 *
 * `logo_url` is a free-text company setting. Only a web URL is a logo the
 * preview can load; anything else (a `javascript:` or `data:` value typed in
 * Settings) prints no logo rather than an attacker-chosen `src`.
 */
function webImageUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "https:" || protocol === "http:" ? trimmed : null;
  } catch {
    return null;
  }
}
