import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { LEGACY_TEMPLATE_STEMS } from "@/lib/legacyTemplateCodes";
import { WORKFLOW_CATALOG } from "@/lib/workflowCatalog";
import {
  WORKFLOW_TEMPLATE_CODES,
  WORKFLOWLESS_TEMPLATE_CODES,
  templateCodesFor,
  workflowsUsingTemplate,
} from "@/lib/workflowTemplates";

/**
 * رموز القوالب المعروفة: جذور القوالب القديمة زائد company-info.
 *
 * `company-info` has no `-ar`/`-en` legacy row, so it never entered
 * LEGACY_TEMPLATE_STEMS — but it is a real template code all the same.
 */
const KNOWN_TEMPLATE_CODES = new Set<string>([
  ...LEGACY_TEMPLATE_STEMS,
  "company-info",
  "whatsapp-session-disconnected",
]);

/** كل الرموز المذكورة في الخريطة زائد القوالب بلا سير عمل. */
function allListedCodes(): string[] {
  return [...Object.values(WORKFLOW_TEMPLATE_CODES).flat(), ...WORKFLOWLESS_TEMPLATE_CODES];
}

describe("the workflow↔template map keys", () => {
  test("every catalogue workflow has a row, and no row names a workflow that does not exist", () => {
    // A new catalogue entry without a row would silently lose its template
    // column; a row without a catalogue entry would render chips for a
    // workflow the registry cannot run.
    expect(Object.keys(WORKFLOW_TEMPLATE_CODES).sort()).toEqual(
      Object.keys(WORKFLOW_CATALOG).sort(),
    );
  });
});

describe("the workflow↔template map codes", () => {
  test("no listed code is unknown", () => {
    // A typo here renders a chip for a template that can never exist, and the
    // "used by" column would claim a sender it does not have.
    for (const code of allListedCodes()) {
      expect(KNOWN_TEMPLATE_CODES.has(code), `unknown template code "${code}"`).toBe(true);
    }
  });

  test("no known template is orphaned: each is mapped or declared workflowless", () => {
    // A template with no row in either list disappears from both the workflow
    // column and the workflowless list — an admin cannot tell what sends it.
    const listed = new Set(allListedCodes());
    for (const code of KNOWN_TEMPLATE_CODES) {
      expect(listed.has(code), `template "${code}" is neither mapped nor workflowless`).toBe(true);
    }
  });

  test('workflowsUsingTemplate("receipt") names both receipt senders', () => {
    // The "used by" column on the receipt row must point at both workflows
    // that send it; a second sender added without updating the map would leave
    // one of them invisible.
    expect(workflowsUsingTemplate("receipt").sort()).toEqual([
      "manual-payment-invoice",
      "payment-succeeded",
    ]);
  });

  test("templateCodesFor returns an empty list for an unknown workflow key", () => {
    // Custom registry rows have no wiring; the chips cell must render "—",
    // not throw.
    expect(templateCodesFor("not-a-workflow")).toEqual([]);
  });
});

/**
 * الملف المرسِل لكل سير عمل مربوط بقالب.
 *
 * Found by grepping the workflow key in src/fns: each file below is the one
 * that runs that key's dispatcher. contract-created/contract-ended are absent
 * on purpose — both go through the `contract-${event}` builder in
 * notifyContractLifecycle.ts, asserted separately below.
 */
const SENDER_FILE: Record<string, string> = {
  "overdue-reminders": "src/fns/overdueRemindersJob.ts",
  "contract-expiry": "src/fns/contractExpiryJob.ts",
  "contact-inquiry-received": "src/fns/notifyContactInquiry.ts",
  "deposit-confirmed": "src/fns/notifyDepositConfirmed.ts",
  "maintenance-request-created": "src/fns/notifyMaintenanceRequest.ts",
  "manual-payment-invoice": "src/fns/notifyPaymentSuccess.ts",
  "payment-succeeded": "src/fns/notifyPaymentSuccess.ts",
  "refund-recorded": "src/fns/notifyRefundRecorded.ts",
  "contract-closeout-completed": "src/fns/notifyContractCloseout.ts",
  "contract-restored": "src/fns/notifyContractRestored.ts",
  "invoice-written-off": "src/fns/notifyInvoiceWrittenOff.ts",
  "invoice-disputed": "src/fns/notifyInvoiceDisputed.ts",
  "user-credentials-managerial": "src/fns/notifyUserCredentials.ts",
  "user-credentials-tenant": "src/fns/notifyUserCredentials.ts",
  "whatsapp-session-disconnected": "src/fns/notifyWhatsappSessionDisconnected.ts",
};

/**
 * يستخرج رموز القوالب من مواضع اختيار القالب فقط في ملف المرسِل.
 *
 * Each alternation is one way a sender selects its template code; anything
 * else that happens to be a quoted string (permission codes like
 * "invoices.dispute" contain dots/underscores and never match the capture).
 * Kept explicit so a sender that selects its code a new way fails loudly
 * instead of passing vacuously.
 */
const TEMPLATE_SELECTION_PATTERN =
  /(?:loadTemplateCopy\(\s*|renderAdminEmailCopy\(\{[^}]*?code:\s*|\btemplateCode:\s*|\bcode:\s*|const\s+\w*[Cc]ode\w*\s*=\s*)"([a-z0-9-]+)"/g;

/** يقرأ ملف المرسِل ويعيد رموز القوالب المختارة فيه. */
function selectedCodesOf(senderFile: string): string[] {
  const source = readFileSync(resolve(process.cwd(), senderFile), "utf8");
  return [...source.matchAll(TEMPLATE_SELECTION_PATTERN)].map((match) => match[1]);
}

describe("per-sender pairing", () => {
  test.each(Object.entries(SENDER_FILE))(
    "%s selects exactly its mapped codes",
    (workflowKey, senderFile) => {
      const selected = selectedCodesOf(senderFile);
      const mapped = WORKFLOW_TEMPLATE_CODES[workflowKey] ?? [];
      // A sender that switched templates (or a typo like "invoice-disputed-v2")
      // must fail here rather than drift from the admin view.
      expect(selected.length, `${senderFile} selects no template code`).toBeGreaterThan(0);
      for (const code of selected) {
        expect(
          KNOWN_TEMPLATE_CODES.has(code),
          `${senderFile} selects unknown template code "${code}"`,
        ).toBe(true);
        expect(
          mapped.includes(code),
          `${senderFile} selects "${code}" which is not mapped to ${workflowKey}`,
        ).toBe(true);
      }
      // A mapped code the sender never selects is a chip that opens a template
      // no run of this workflow can ever send.
      for (const code of mapped) {
        expect(
          selected.includes(code),
          `"${code}" is mapped to ${workflowKey} but never selected in ${senderFile}`,
        ).toBe(true);
      }
    },
  );

  test.each(["contract-created", "contract-ended"])(
    "%s is produced by the contract-${event} builder",
    (workflowKey) => {
      // These two share one sender file whose selection is a computed
      // `contract-${event}` string, not a literal — the pairing is asserted on
      // the builder so a renamed event still resolves to its mapped code.
      const source = readFileSync(
        resolve(process.cwd(), "src/fns/notifyContractLifecycle.ts"),
        "utf8",
      );
      expect(source).toContain("`contract-${event}`");
      const event = workflowKey === "contract-created" ? "created" : "ended";
      expect(`contract-${event}`).toBe(WORKFLOW_TEMPLATE_CODES[workflowKey]?.[0]);
    },
  );
});
