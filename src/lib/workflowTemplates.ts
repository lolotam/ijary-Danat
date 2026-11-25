/**
 * يربط كل سير عمل مدمج برموز قوالب الإشعارات التي يرسلها.
 *
 * Senders hard-code their template codes (src/fns/notify*, *Job.ts); this map
 * is the admin-facing view of that wiring. workflowTemplates.test.ts fails when
 * a sender and this map disagree, so it cannot drift silently.
 */
export const WORKFLOW_TEMPLATE_CODES: Readonly<Record<string, readonly string[]>> = {
  overdue: [],
  "overdue-reminders": ["overdue-reminder"],
  "contract-expiry": ["contract-expiry"],
  "scheduled-reports": [],
  "notification-drain": [],
  "gmail-sync": [],
  salaries: [],
  "payment-reconcile": [],
  backup: [],
  "log-retention": [],
  "contact-inquiry-received": ["contact-inquiry"],
  "contract-created": ["contract-created"],
  "contract-ended": ["contract-ended"],
  "deposit-confirmed": ["deposit-confirmation"],
  "maintenance-request-created": ["maintenance-request"],
  "manual-payment-invoice": ["receipt", "payment-admin-alert"],
  "payment-succeeded": ["receipt", "payment-admin-alert"],
  "refund-recorded": ["refund-recorded"],
  "contract-closeout-completed": ["contract-closeout"],
  "contract-restored": ["contract-restored"],
  "invoice-written-off": ["invoice-written-off"],
  "invoice-disputed": ["invoice-disputed"],
  "user-credentials-managerial": ["user-credentials"],
  "user-credentials-tenant": ["user-credentials"],
  "whatsapp-session-disconnected": ["whatsapp-session-disconnected"],
};

/** قوالب تُرسل يدوياً بلا سير عمل، فلا تظهر في عمود القالب. */
export const WORKFLOWLESS_TEMPLATE_CODES: readonly string[] = [
  "invoice-document",
  "company-info",
  "due-reminder",
];

/**
 * يعيد رموز القوالب لسير عمل، أو قائمة فارغة لسير عمل مخصص غير مربوط.
 */
export function templateCodesFor(workflowKey: string): readonly string[] {
  return WORKFLOW_TEMPLATE_CODES[workflowKey] ?? [];
}

/**
 * يعيد مفاتيح سير العمل التي ترسل قالباً معيناً (عمود «مستخدم في»).
 */
export function workflowsUsingTemplate(code: string): string[] {
  return Object.keys(WORKFLOW_TEMPLATE_CODES).filter((key) =>
    WORKFLOW_TEMPLATE_CODES[key]!.includes(code),
  );
}
