import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { isBuiltInWorkflow } from "@/lib/workflowCatalog";

import { JOB_CATALOG, PAYMENT_RECEIPT_WORKFLOWS, type JobKind, type NoticeTarget } from "./catalog";

const kinds = Object.keys(JOB_CATALOG);

const CONTRACT_PATH = resolve(__dirname, "../../specs/001-multi-company-saas/contracts/jobs.md");
const MIGRATION_PATH = resolve(__dirname, "../../db/migrations/306_job_requests.sql");

/** يقرأ القسم الممتد بين عنوانين من عقد الوظائف. */
function contractSection(from: string, to: string): string {
  const doc = readFileSync(CONTRACT_PATH, "utf8");
  return doc.slice(doc.indexOf(from), doc.indexOf(to));
}

/** يستخرج أسماء أنواع المهام المذكورة في جدول الكتالوج بالعقد (القسم 5). */
function contractKinds(): string[] {
  const section = contractSection("## 5. Catalogue", "## 6.");
  return [...section.matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)].map((m) => m[1]);
}

/** يقرأ صفوف جدول الكتالوج في القسم 5 ويعيد خلايا كل صف. */
function contractCatalogueRows(): string[][] {
  return contractSection("## 5. Catalogue", "## 6.")
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells[0] !== "Kind" && !cells.every((cell) => /^-{3,}$/.test(cell)));
}

/** يربط كل خلية في عمود الإشعار بالعقد بقيمة الإشعار المقابلة في الكتالوج. */
const NOTICE_BY_CELL: Record<string, NoticeTarget> = {
  no: "none",
  yes: "requester",
  "yes (platform)": "platform",
};

describe("job catalogue (T060)", () => {
  test("every kind passes the job_requests.kind check in migration 306", () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    const pattern = /check \(kind ~ '([^']+)'\)/.exec(migration)?.[1];
    expect(pattern, "migration 306 must keep a `check (kind ~ '...')` constraint").toBeTruthy();
    const sqlCheck = new RegExp(pattern ?? "");
    expect(kinds.filter((kind) => !sqlCheck.test(kind))).toEqual([]);
  });

  test("the catalogue names exactly the kinds in contracts/jobs.md section 5", () => {
    expect([...kinds].sort()).toEqual([...new Set(contractKinds())].sort());
  });

  test("each catalogue kind routes to the queue and notice its contract row names", () => {
    const mismatches: string[] = [];

    for (const cells of contractCatalogueRows()) {
      const [kindCell, queueCell, , noticeCell] = cells;
      const named = [...kindCell.matchAll(/`([a-z_]+\.[a-z_]+)`/g)].map((m) => m[1]);
      // The fan-out row names several kinds and starts from the platform cron
      // queue, so the contract gives it no single queue or notice to check.
      if (named.length !== 1 || queueCell.startsWith("cron fan-out")) continue;
      const [kind] = named;
      const entry = JOB_CATALOG[kind as keyof typeof JOB_CATALOG];
      if (!entry) {
        mismatches.push(`${kind}: missing from the catalogue`);
        continue;
      }
      const queue = /notify|docs|bulk|sync|inbound|cron/.exec(queueCell)?.[0];
      const notice = NOTICE_BY_CELL[noticeCell];
      if (entry.queue !== queue)
        mismatches.push(`${kind}: queue ${entry.queue} vs contract ${queue}`);
      if (entry.notice !== notice)
        mismatches.push(`${kind}: notice ${entry.notice} vs contract ${notice}`);
    }

    expect(mismatches).toEqual([]);
  });
});

describe("the payloads that carry the request's choices", () => {
  const TENANT_ID = "11111111-1111-4111-8111-111111111111";
  const PAYMENT_ID = "22222222-2222-4222-8222-222222222222";

  test.each<[JobKind, Record<string, unknown>]>([
    ["company.info.send", { tenantId: TENANT_ID, channels: ["email"], language: "en" }],
    ["payment.receipt", { paymentId: PAYMENT_ID, workflow: "manual-payment-invoice" }],
  ])("%s accepts the payload it documents", (kind, payload) => {
    expect(JOB_CATALOG[kind].payload.safeParse(payload).success).toBe(true);
  });

  test.each<[JobKind, Record<string, unknown>]>([
    ["company.info.send", { tenantId: TENANT_ID, channels: ["sms"], language: "en" }],
    ["company.info.send", { tenantId: TENANT_ID, channels: [], language: "en" }],
    ["company.info.send", { tenantId: TENANT_ID, channels: ["email"], language: "fr" }],
    ["payment.receipt", { paymentId: PAYMENT_ID, workflow: "manual-payment" }],
  ])("%s rejects the payload %j", (kind, payload) => {
    // A channel or a workflow the catalogue does not know would leave the
    // worker guessing; the schema stops it at the enqueue instead.
    expect(JOB_CATALOG[kind].payload.safeParse(payload).success).toBe(false);
  });

  test("every receipt workflow the catalogue accepts is a built-in workflow", () => {
    // The worker reads the switch and the recipients of the key the payload
    // names, so a key the registry does not know would fall back to everybody.
    expect(PAYMENT_RECEIPT_WORKFLOWS.filter((key) => !isBuiltInWorkflow(key))).toEqual([]);
  });
});
