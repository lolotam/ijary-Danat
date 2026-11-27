/**
 * Translation keys (en) for requesting a password reset and for changing it.
 *
 * The "forgot my password" screen answers the same sentence whether or not the
 * account exists, so the wording must not promise a message that may never be
 * sent.
 */
export const passwordReset: Record<string, string> = {
  "passwordReset.title": "Reset your password",

  "passwordReset.request.title": "Forgot your password?",
  "passwordReset.request.description":
    "Enter your username, email address or mobile number and we will send you a link to reset your password.",
  "passwordReset.request.identifier": "Username, email address or mobile number",
  "passwordReset.request.submit": "Send reset link",
  "passwordReset.request.sent":
    "If the account exists, we have sent it a link to reset your password.",

  "passwordReset.change.title": "Set a new password",
  "passwordReset.change.description": "Choose a new password for your account.",
  "passwordReset.newPassword": "New password",
  "passwordReset.confirmPassword": "Confirm password",
  "passwordReset.submit": "Save password",
  "passwordReset.changed": "Your password was changed. You can sign in now.",
  "passwordReset.mismatch": "The two passwords do not match.",
  "passwordReset.weak": "The password must be at least 8 characters.",
  "passwordReset.failed": "The password could not be changed. Try again.",

  "passwordReset.invalidToken": "This reset link is not valid. Request a new one.",
  "passwordReset.usedToken": "This reset link has already been used. Request a new one.",
  "passwordReset.expiredToken": "This reset link has expired. Request a new one.",

  "passwordReset.forced.title": "You must change your temporary password",
  "passwordReset.forced.description":
    "Your account still uses the temporary password. Change it now to keep using the system.",
  "passwordReset.signIn": "Sign in",
  "passwordReset.requestAnother": "Request a new link",
};
