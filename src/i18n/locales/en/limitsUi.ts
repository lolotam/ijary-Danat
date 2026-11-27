/**
 * مفاتيح الترجمة الإنجليزية لشاشات حدود الشركة واستهلاكها.
 *
 * The keys mirror the Arabic `limitsUi.ts` exactly; the locale-parity test fails on any drift.
 */
export const limitsUi: Record<string, string> = {
  "limitsUi.title": "Company limits",
  "limitsUi.units": "Rental units",
  "limitsUi.staff": "Staff accounts",
  "limitsUi.whatsapp": "WhatsApp messages per month",
  "limitsUi.storage": "Storage",
  "limitsUi.unlimited": "Unlimited",
  "limitsUi.maxLabel": "Maximum (leave blank for unlimited)",
  "limitsUi.save": "Save limits",
  "limitsUi.saved": "Limits saved.",
  "limitsUi.loadError": "Could not read the limits.",
  "limitsUi.saveError": "Could not save the limits.",
  "limitsUi.invalidValue": "Enter a non-negative whole number, or leave the field blank.",
  "limitsUi.lowerWarning":
    "Lowering a limit blocks new additions once reached; existing data is never deleted.",
  "limitsUi.usage.title": "Company usage",
  "limitsUi.usage.description": "Current use against the company limits.",
  "limitsUi.usage.notice": "Usage of at least one limit has reached 80% or more.",
  "limitsUi.usage.loadError": "Could not read usage.",
  "limitsUi.usage.megabytes": "MB",
  "limitsUi.usage.gigabytes": "GB",
};
