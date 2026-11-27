/**
 * Support session copy: the platform panel that starts the session, the red
 * banner inside the company panel, and the session entry page (English).
 *
 * The refusal codes live beside the platform operations in
 * `src/platform/supportSession.ts`; this file carries the sentences the screens
 * show around them.
 */
export const supportSession: Record<string, string> = {
  "supportSession.platform.title": "Support session",
  "supportSession.platform.description":
    "The super admin opens the company panel as one of its staff accounts, and the session is written to the platform audit log.",
  "supportSession.platform.reason": "Reason",
  "supportSession.platform.reasonHint":
    "The reason is required, and it shows in the banner inside the company panel.",
  "supportSession.platform.target": "Staff account",
  "supportSession.platform.targetHint": "Pick an active staff account of this company.",
  "supportSession.platform.start": "Start support session",
  "supportSession.platform.starting": "Starting…",
  "supportSession.platform.linkTitle": "Entry link (one time)",
  "supportSession.platform.linkHint":
    "The token sits in the fragment after #, so it never reaches the server logs or the landing page.",
  "supportSession.platform.copy": "Copy the link",
  "supportSession.platform.copied": "Link copied.",
  "supportSession.platform.openSessions": "Open sessions",
  "supportSession.platform.noOpenSessions": "No open support session for this company.",
  "supportSession.platform.expiresAt": "Ends at",
  "supportSession.platform.end": "End session",
  "supportSession.platform.ending": "Ending…",
  "supportSession.platform.error.reasonRequired": "Write the reason before starting.",
  "supportSession.platform.error.targetRequired": "Pick the staff account whose panel will open.",
  "supportSession.platform.error.generic": "The action could not be completed. Try again.",

  "supportSession.banner.title": "Support session active",
  "supportSession.banner.by": "Platform admin {name} is inside this company panel now.",
  "supportSession.banner.reason": "Reason: {reason}",
  "supportSession.banner.expiresAt": "The session ends at {time}.",
  "supportSession.banner.end": "End support session",
  "supportSession.banner.ending": "Ending…",
  "supportSession.banner.error": "The support session could not be ended.",

  "supportSession.route.title": "Opening the support session",
  "supportSession.route.opening": "Opening the support session…",
  "supportSession.route.refused":
    "The support session could not be opened. Ask the super admin for a new link.",
  "supportSession.route.noToken":
    "This link carries no session token. Ask the super admin for a new link.",
  "supportSession.route.signIn": "Go to sign in",

  "supportSession.error.NO_CALLER_SESSION": "The session is over. Sign in again.",
  "supportSession.error.TARGET_USER_NOT_IN_COMPANY":
    "That account does not belong to this company.",
  "supportSession.error.SUPPORT_SESSION_NOT_FOUND": "The support session does not exist.",
  "supportSession.error.COMPANY_SUSPENDED": "This company account is suspended.",
};
