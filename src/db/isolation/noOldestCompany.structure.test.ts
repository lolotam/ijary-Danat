import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { migrationFilesSorted } from "@/db/resolveLiveMigration";

const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const SRC_DIR = resolve(process.cwd(), "src");

interface LiveFunctionDef {
  file: string;
  name: string;
  body: string;
}

/**
 * يزيل تعليقات SQL والكتل النصية البسيطة للحكم على الاستعلامات الفعلية فقط.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * يبحث عن نهاية تعريف الدالة عند علامة الإغلاق الدولارية (`$$` أو `$fn$`) والفاصلة المنقوطة التابعة لها.
 */
function findFunctionEndPos(sql: string, startPos: number): number {
  const afterStart = sql.slice(startPos);
  const openMatch = /\bas\s+(\$[A-Za-z0-9_]*\$)/i.exec(afterStart);
  if (!openMatch || openMatch.index === undefined) {
    const semi = sql.indexOf(";", startPos);
    return semi === -1 ? sql.length : semi + 1;
  }
  const tag = openMatch[1];
  const bodyStart = startPos + openMatch.index + openMatch[0].length;
  const closeIdx = sql.indexOf(tag, bodyStart);
  if (closeIdx === -1) return sql.length;
  const endSemi = sql.indexOf(";", closeIdx + tag.length);
  return endSemi === -1 ? closeIdx + tag.length : endSemi + 1;
}

/**
 * يستخرج آخر تعريف لكل دالة في `public` عبر ملفات الهجرة بترتيبها الرقمي، مع تتبع أوامر `DROP FUNCTION`.
 */
function collectLiveMigrationFunctions(): Map<string, LiveFunctionDef> {
  const live = new Map<string, LiveFunctionDef>();
  const dropRe = /drop\s+function\s+(?:if\s+exists\s+)?public\.([a-z0-9_]+)\s*\(([^)]*)\)/gi;
  const createRe = /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)/gi;

  for (const file of migrationFilesSorted()) {
    const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const sql = stripSqlComments(raw);

    type Event = { pos: number; kind: "drop" | "create"; name: string; args: string };
    const events: Event[] = [];

    for (const match of sql.matchAll(dropRe)) {
      events.push({
        pos: match.index ?? 0,
        kind: "drop",
        name: match[1].toLowerCase(),
        args: match[2].replace(/\s+/g, " ").trim().toLowerCase(),
      });
    }
    for (const match of sql.matchAll(createRe)) {
      events.push({
        pos: match.index ?? 0,
        kind: "create",
        name: match[1].toLowerCase(),
        args: match[2].replace(/\s+/g, " ").trim().toLowerCase(),
      });
    }
    events.sort((a, b) => a.pos - b.pos);

    for (const ev of events) {
      // Key by name + argument count so renames of parameter names still replace
      // the prior definition while preserving distinct arities.
      const argCount = ev.args === "" ? 0 : ev.args.split(",").length;
      const key = `${ev.name}/${argCount}`;
      if (ev.kind === "drop") {
        live.delete(key);
        continue;
      }

      const endPos = findFunctionEndPos(sql, ev.pos);
      live.set(key, {
        file,
        name: ev.name,
        body: sql.slice(ev.pos, endPos),
      });
    }
  }

  return live;
}

/**
 * يجمع مسارات ملفات المصدر الإنتاجية (دون ملفات الاختبار) تحت مجلد معيّن.
 */
function collectProductionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return collectProductionFiles(full);
    if (!/\.(ts|tsx)$/.test(entry)) return [];
    if (entry.includes(".test.") || entry.includes(".sqltest.")) return [];
    return [full];
  });
}

/**
 * يبحث عن استعلامات "أقدم شركة" (`from companies … limit 1`) في ملفات المصدر.
 */
function findOldestCompanyInSrc(): string[] {
  const hits: string[] = [];
  const rawSqlPattern = /\bfrom\s+(?:public\.)?companies\b[^;]*\blimit\s+1\b/i;

  for (const file of collectProductionFiles(SRC_DIR)) {
    const source = readFileSync(file, "utf8");
    const rel = relative(SRC_DIR, file).replace(/\\/g, "/");

    let idx = source.indexOf('.from("companies")');
    while (idx !== -1) {
      const end = source.indexOf(";", idx);
      const stmt = source.slice(idx, end === -1 ? undefined : end);
      if (
        stmt.includes(".limit(1)") &&
        !stmt.includes('.eq("id"') &&
        !stmt.includes('.eq("slug"')
      ) {
        hits.push(`${rel}: .from("companies")…limit(1)`);
        break;
      }
      idx = source.indexOf('.from("companies")', idx + 1);
    }

    if (rawSqlPattern.test(source)) {
      hits.push(`${rel}: SQL from companies … limit 1`);
    }
  }

  return hits;
}

/**
 * يتحقق من خلوّ آخر تعريفات الدوال في الهجرات وملفات المصدر من نمط "أقدم شركة" (`from companies … limit 1`).
 */
describe("no oldest-company lookup remains (T014)", () => {
  test("no latest function definition in db/migrations selects from companies limit 1", () => {
    const liveFns = collectLiveMigrationFunctions();
    expect(liveFns.size).toBeGreaterThan(0);

    const pattern = /\bfrom\s+(?:public\.)?companies\b[^;]*\blimit\s+1\b/i;
    const offending: string[] = [];

    for (const def of liveFns.values()) {
      if (pattern.test(def.body)) {
        offending.push(`${def.file}: ${def.name}`);
      }
    }

    expect(offending).toEqual([]);
  });

  test("no production source file in src/ queries companies with limit 1 without id/slug", () => {
    expect(findOldestCompanyInSrc()).toEqual([]);
  });
});
