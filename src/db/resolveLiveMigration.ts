import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Live definition resolution for structure tests.
 *
 * This repo uses supersede-by-number: the LIVE body of a function is the one in
 * the highest-numbered migration that contains
 * `create or replace function public.<name>(`. Pinning a structure test to the
 * migration that first introduced a guard is blind once a later migration
 * re-issues the function — the guard can be dropped and the test still green.
 */

const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

const migrationTextCache = new Map<string, string>();

/**
 * يقرأ نص ملف الهجرة مرة واحدة في كل تشغيل للاختبارات ثم يعيده من الذاكرة.
 *
 * Every resolve scans all ~220 migrations, and a structure test resolves
 * several functions per case, so the same files were read from disk dozens
 * of times per test. Under full-suite parallel load that pushed
 * `moduleSummaries.structure.test.ts` past Vitest's 5s timeout. Migration
 * files do not change during a run, so caching their text is safe.
 */
function readMigration(file: string): string {
  let text = migrationTextCache.get(file);
  if (text === undefined) {
    text = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    migrationTextCache.set(file, text);
  }
  return text;
}

export function migrationFilesSorted(): string[] {
  return (
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_[\w.-]+\.sql$/.test(f))
      // Number first, then filename. Without the tie-break two files sharing a
      // migration number compare equal and fall back to `readdirSync` order,
      // which is filesystem-dependent — so "which one is live" would differ
      // between a developer's machine and CI.
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b))
  );
}

/**
 * Highest-numbered migration file that defines public.<fnName>(…).
 * Scans every migration so a re-issue in a later file is never missed.
 */
export function resolveLiveMigrationFile(fnName: string): string {
  const needle = `create or replace function public.${fnName}(`;
  let best: string | null = null;
  for (const file of migrationFilesSorted()) {
    const text = readMigration(file);
    if (text.includes(needle)) best = file;
  }
  if (!best) {
    throw new Error(`No migration defines public.${fnName}(`);
  }
  return best;
}

/** Full text of the highest-numbered migration that defines public.<fnName>(…). */
export function liveMigrationSql(fnName: string): string {
  return readMigration(resolveLiveMigrationFile(fnName));
}
