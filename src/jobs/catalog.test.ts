import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { JOB_CATALOG, type NoticeTarget } from "./catalog";

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
