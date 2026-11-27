/**
 * English keys for the super admin shell, sign-in, second factor and audit log.
 *
 * Must stay key-for-key identical to `ar/platform.ts` or `dictionary.test.ts`
 * fails the build.
 */
export const platform: Record<string, string> = {
  "platform.title": "Platform administration",
  "platform.subtitle": "Super admin area",
  "platform.nav.overview": "Overview",
  "platform.nav.companies": "Companies",
  "platform.nav.audit": "Audit log",
  "platform.signOut": "Sign out",
  "platform.language": "العربية",
  "platform.loading": "Checking super admin access…",
  "platform.error": "Could not verify super admin access.",

  "platform.login.title": "Super admin sign-in",
  "platform.login.subtitle": "Platform accounts are separate from company accounts.",
  "platform.login.email": "Login ID",
  "platform.login.password": "Password",
  "platform.login.submit": "Sign in",
  "platform.login.submitting": "Signing in…",
  "platform.login.error.forbidden": "This account is not a super admin.",
  "platform.login.error.invalid": "Incorrect login ID or password.",
  "platform.login.error.generic": "Sign-in failed. Please try again.",
  "platform.login.note": "After signing in you will set up or enter a second factor.",

  "platform.mfa.title": "Two-factor verification",
  "platform.mfa.subtitle": "No platform data is shown before the second factor.",
  "platform.mfa.enrollHint":
    "Scan the QR code or add the key to your authenticator app, then enter its code.",
  "platform.mfa.scan": "Enrollment QR code",
  "platform.mfa.secret": "Enrollment key",
  "platform.mfa.verifiedHint": "Enter the current code from your authenticator app.",
  "platform.mfa.code": "Verification code",
  "platform.mfa.submit": "Verify code",
  "platform.mfa.submitting": "Verifying…",
  "platform.mfa.error.code": "Enter a six-digit code.",
  "platform.mfa.error.generic": "Verification failed. Check the code and try again.",
  "platform.mfa.signOut": "Sign out",

  "platform.audit.title": "Platform audit log",
  "platform.audit.subtitle": "Every super admin action, with no secrets or passwords.",
  "platform.audit.time": "Time",
  "platform.audit.actor": "Actor",
  "platform.audit.action": "Action",
  "platform.audit.entity": "Entity",
  "platform.audit.company": "Company",
  "platform.audit.unknownActor": "Unknown",
  "platform.audit.noCompany": "Platform-wide",
  "platform.audit.empty": "No records on this page.",
  "platform.audit.error": "Could not read the audit log.",
  "platform.audit.previous": "Previous",
  "platform.audit.next": "Next",
  "platform.audit.page": "Page",
  "platform.audit.of": "of",
};
