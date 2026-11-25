/**
 * رموز القوالب القديمة ذات اللاحقة اللغوية، التي تحذفها الترحيلة 125.
 *
 * Used to hide these rows in the window between migrations 124 and 125, when the
 * table briefly holds all three variants of every template.
 *
 * An explicit list, deliberately not a `-ar`/`-en` pattern: the schema has never
 * reserved those suffixes, so an admin-created `lease-renewal-ar` is legitimate
 * and must survive both the filter and the migrations.
 */
export const LEGACY_TEMPLATE_STEMS = [
  "due-reminder",
  "overdue-reminder",
  "receipt",
  "contract-expiry",
  "invoice-document",
  "deposit-confirmation",
  "user-credentials",
  "payment-admin-alert",
  "contact-inquiry",
  "maintenance-request",
  "refund-recorded",
  "contract-created",
  "contract-ended",
  "contract-closeout",
  "contract-restored",
  "invoice-written-off",
  "invoice-disputed",
] as const;

export const LEGACY_TEMPLATE_CODES: readonly string[] = LEGACY_TEMPLATE_STEMS.flatMap((stem) => [
  `${stem}-ar`,
  `${stem}-en`,
]);
