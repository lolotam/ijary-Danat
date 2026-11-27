/**
 * Translation of the platform screens: companies and their accounts (English).
 *
 * The refusal codes live beside these strings in `platformCompanies.ts`; this
 * file carries the sentences the screens show around them.
 */
export const platformCompaniesUi: Record<string, string> = {
  "platformCompaniesUi.title": "Companies",
  "platformCompaniesUi.subtitle": "Every company registered on the platform.",
  "platformCompaniesUi.create": "New company",
  "platformCompaniesUi.search": "Search",
  "platformCompaniesUi.searchPlaceholder": "Company name or short name",
  "platformCompaniesUi.filter.label": "Status",
  "platformCompaniesUi.filter.all": "All",
  "platformCompaniesUi.filter.active": "Active",
  "platformCompaniesUi.filter.suspended": "Suspended",
  "platformCompaniesUi.column.name": "Name",
  "platformCompaniesUi.column.slug": "Short name",
  "platformCompaniesUi.column.status": "Status",
  "platformCompaniesUi.column.users": "Accounts",
  "platformCompaniesUi.column.created": "Created",
  "platformCompaniesUi.status.active": "Active",
  "platformCompaniesUi.status.suspended": "Suspended",
  "platformCompaniesUi.empty": "No matching company.",
  "platformCompaniesUi.error.load": "The companies could not be read.",
  "platformCompaniesUi.error.generic": "The action could not be completed. Try again.",
  "platformCompaniesUi.page": "Page",
  "platformCompaniesUi.of": "of",
  "platformCompaniesUi.open": "Open",

  "platformCompaniesUi.create.title": "Create a company",
  "platformCompaniesUi.create.description":
    "The company is created with its first administrator and its default data, and that administrator receives a temporary password.",
  "platformCompaniesUi.create.nameAr": "Arabic name",
  "platformCompaniesUi.create.nameEn": "English name",
  "platformCompaniesUi.create.slug": "Short name",
  "platformCompaniesUi.create.slugHint":
    "Lower-case letters, digits and hyphens, 3 to 32 characters, with no hyphen at either end.",
  "platformCompaniesUi.create.slugInvalid": "This short name is not valid.",
  "platformCompaniesUi.create.adminName": "First administrator's name",
  "platformCompaniesUi.create.adminUsername": "Username (optional)",
  "platformCompaniesUi.create.adminEmail": "Email address (optional)",
  "platformCompaniesUi.create.adminPhone": "Phone number (optional)",
  "platformCompaniesUi.create.submit": "Create the company",
  "platformCompaniesUi.create.submitting": "Creating…",
  "platformCompaniesUi.create.host": "Company address",
  "platformCompaniesUi.create.tempPassword": "Temporary password for the first administrator",
  "platformCompaniesUi.create.tempPasswordWarning":
    "This password will not be shown again. Copy it now and hand it to the first administrator; they will change it at the first sign-in.",
  "platformCompaniesUi.create.copy": "Copy",
  "platformCompaniesUi.create.copied": "The password was copied.",
  "platformCompaniesUi.create.done": "Done",

  "platformCompaniesUi.detail.title": "Company details",
  "platformCompaniesUi.detail.slugReadOnly":
    "The short name cannot change after the company is created.",
  "platformCompaniesUi.detail.suspendedAt": "Suspended at",
  "platformCompaniesUi.detail.suspendedReason": "Reason for suspension",
  "platformCompaniesUi.detail.error.nameRequired":
    "Write the company's name in Arabic and in English before saving.",

  "platformCompaniesUi.status.suspend": "Suspend the company",
  "platformCompaniesUi.status.activate": "Reactivate",
  "platformCompaniesUi.status.suspendTitle": "Suspend the company",
  "platformCompaniesUi.status.suspendBody":
    "The company's staff and renters reach neither its panel nor its portal until it is reactivated.",
  "platformCompaniesUi.status.activateTitle": "Reactivate the company",
  "platformCompaniesUi.status.activateBody":
    "The company goes back to work with all of its data as it is.",
  "platformCompaniesUi.status.reason": "Reason for the decision",
  "platformCompaniesUi.status.reasonHint":
    "3 to 500 characters, recorded in the platform audit log.",
  "platformCompaniesUi.status.reasonInvalid": "Write a reason of at least 3 characters.",
  "platformCompaniesUi.status.confirm": "Confirm",
  "platformCompaniesUi.status.busy": "Working…",

  "platformCompaniesUi.users.title": "Company accounts",
  "platformCompaniesUi.users.create": "New account",
  "platformCompaniesUi.users.role": "Role",
  "platformCompaniesUi.users.active": "Active",
  "platformCompaniesUi.users.inactive": "Suspended",
  "platformCompaniesUi.users.activate": "Activate",
  "platformCompaniesUi.users.deactivate": "Suspend",
  "platformCompaniesUi.users.resetPassword": "Reset the password",
  "platformCompaniesUi.users.mustChange": "Must change the password at the first sign-in",
  "platformCompaniesUi.users.empty": "This company has no accounts.",
  "platformCompaniesUi.users.create.title": "New account",
  "platformCompaniesUi.users.create.fullName": "Full name",
  "platformCompaniesUi.users.create.username": "Username (optional)",
  "platformCompaniesUi.users.create.email": "Email address (optional)",
  "platformCompaniesUi.users.create.phone": "Phone number (optional)",
  "platformCompaniesUi.users.create.role": "Role",
  "platformCompaniesUi.users.create.submit": "Create the account",
  "platformCompaniesUi.users.create.submitting": "Creating…",
  "platformCompaniesUi.users.tempPassword": "Temporary password",
  "platformCompaniesUi.users.tempPasswordWarning":
    "This password will not be shown again. Copy it now and hand it to the account's owner.",
  "platformCompaniesUi.users.copy": "Copy",
  "platformCompaniesUi.users.copied": "The password was copied.",
  "platformCompaniesUi.users.password.title": "Reset the password",
  "platformCompaniesUi.users.password.body":
    "The account's current sessions are revoked, and its owner must change the password at the first sign-in.",
  "platformCompaniesUi.users.role.admin": "Administrator",
  "platformCompaniesUi.users.role.accountant": "Accountant",
  "platformCompaniesUi.users.role.collector": "Collector",
  "platformCompaniesUi.users.role.readonly": "Read only",
};
