/**
 * ترجمة تأكيدات الإجراءات المؤجَّلة (الإنجليزية).
 *
 * The Arabic file is the source of truth; this mirrors its keys exactly so the
 * two locales stay in parity (see `src/i18n/dictionary.test.ts`).
 *
 * A screen that queued work has not done it yet: the request wrote the row or
 * filed the job and returned, and the worker is the one that runs it. These
 * strings therefore say "queued", never "sent" or "generated".
 *
 * Accurate about where the outcome shows up: an ordinary message is followed in
 * the notification log, and a scheduled report is built, sent, and then listed
 * among the generated reports.
 */
export const deferred = {
  "deferred.messageQueued":
    "Message queued — it will be sent in the background. Follow its state in the notification log.",
  "deferred.reportQueued":
    "Report queued — it will be built and sent in the background. It will appear in the generated reports list.",
} as const;
