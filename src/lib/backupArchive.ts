import * as fflate from "fflate";

/**
 * إصدار تنسيق الأرشيف الحالي.
 */
export const BACKUP_FORMAT_VERSION = 1;

/**
 * الحد الأقصى لحجم البيانات غير المضغوطة بالبايت — حماية ضد قنابل الضغط.
 *
 * 256 MiB is generous for a database with tens of contracts and hundreds of
 * invoices, but catches a decompression bomb before it exhausts memory.
 * Checked against the central directory's reported sizes before we call
 * fflate.unzipSync, so a true bomb never decompresses.
 */
export const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

export type BackupKind = "manual" | "automatic" | "pre_restore";
export type BackupFrequency = "daily" | "weekly";

export interface BackupManifestTable {
  name: string;
  rows: number;
}

export interface BackupManifest {
  format_version: number;
  schema_fingerprint: string;
  created_at: string;
  kind: BackupKind;
  tables: BackupManifestTable[];
  row_count: number;
}

export interface BackupTableData {
  name: string;
  rows: unknown[];
}

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * إزاحة توقيت الكويت بالمللي ثانية — UTC+3 بلا توقيت صيفي.
 */
const KUWAIT_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * يحوّل تاريخاً إلى توقيت الكويت بحيث تُقرأ دوال UTC كساعة حائط الكويت.
 *
 * Asia/Kuwait is UTC+3 year-round with no daylight saving, so a fixed
 * +3 offset is correct. Reused by backupFileName, periodKeyFor, and the
 * ISO-week helper — the arithmetic lives in one place.
 */
function toKuwaitDate(d: Date): Date {
  return new Date(d.getTime() + KUWAIT_OFFSET_MS);
}

/** بيانات ملف داخل أرشيف ZIP مستخرجة من الدليل المركزي. */
interface ZipEntryInfo {
  name: string;
  uncompressedSize: number;
}

/**
 * يقرأ أسماء الملفات وأحجامها من الدليل المركزي لملف ZIP.
 *
 * Parses the central directory before decompression so we can detect
 * duplicate entries (which fflate's JS-object output silently merges)
 * and oversized payloads (which would exhaust memory before any
 * post-hoc check). Returns an empty array if the EOCD cannot be found;
 * fflate will throw its own error later in that case.
 */
function scanZipEntries(bytes: Uint8Array): ZipEntryInfo[] {
  const decoder = new TextDecoder();
  const entries: ZipEntryInfo[] = [];

  // End of Central Directory record — signature PK\x05\x06
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return entries;

  const entryCount = bytes[eocdOffset + 10] | (bytes[eocdOffset + 11] << 8);
  const cdOffset =
    (bytes[eocdOffset + 16] |
      (bytes[eocdOffset + 17] << 8) |
      (bytes[eocdOffset + 18] << 16) |
      (bytes[eocdOffset + 19] << 24)) >>>
    0;

  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    // Central-directory header signature: PK\x01\x02
    if (
      pos + 46 > bytes.length ||
      bytes[pos] !== 0x50 ||
      bytes[pos + 1] !== 0x4b ||
      bytes[pos + 2] !== 0x01 ||
      bytes[pos + 3] !== 0x02
    ) {
      break;
    }

    let uncompressedSize =
      (bytes[pos + 24] |
        (bytes[pos + 25] << 8) |
        (bytes[pos + 26] << 16) |
        (bytes[pos + 27] << 24)) >>>
      0;
    const filenameLen = bytes[pos + 28] | (bytes[pos + 29] << 8);
    const extraLen = bytes[pos + 30] | (bytes[pos + 31] << 8);
    const commentLen = bytes[pos + 32] | (bytes[pos + 33] << 8);

    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + filenameLen));

    // 0xFFFFFFFF is the ZIP64 sentinel value for "size is in the extra field".
    // We don't parse the extra field, so we treat it as an unknown size (0) for
    // the pre-check, and rely on the post-decompression check to catch it.
    if (uncompressedSize === 0xffffffff) {
      uncompressedSize = 0;
    }

    entries.push({ name, uncompressedSize });

    pos += 46 + filenameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * يحسب رقم الأسبوع والسنة وفق معيار ISO 8601 من تاريخ ذي قيم UTC.
 *
 * ISO weeks start on Monday; the ISO year of a date is the calendar year
 * of the Thursday in that date's week, which can differ from the calendar
 * year at year boundaries (e.g. 2027-01-01 Friday → 2026-W53).
 */
function isoWeekOf(utcDate: Date): { year: number; week: number } {
  const d = new Date(
    Date.UTC(utcDate.getUTCFullYear(), utcDate.getUTCMonth(), utcDate.getUTCDate()),
  );
  // Shift to the Thursday of this ISO week: Mon=1 … Sun=7
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

// ─── Exported functions ──────────────────────────────────────────────────

/**
 * يجمع الجداول في ملف ZIP واحد مضغوط مع بيان محتوياته.
 *
 * Packs the given tables into a ZIP with a manifest. Tables are sorted
 * by name for reproducible archives; JSON is minified to minimize size.
 * The schema fingerprint is carried verbatim — the database computes it,
 * this module only stores and round-trips it.
 */
export function buildArchive(
  tables: BackupTableData[],
  meta: { kind: BackupKind; createdAt: Date; schemaFingerprint: string },
): { bytes: Uint8Array; manifest: BackupManifest } {
  const manifest: BackupManifest = {
    format_version: BACKUP_FORMAT_VERSION,
    schema_fingerprint: meta.schemaFingerprint,
    created_at: meta.createdAt.toISOString(),
    kind: meta.kind,
    tables: [],
    row_count: 0,
  };

  const sortedTables = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  const zipData: Record<string, Uint8Array> = {};
  const enc = new TextEncoder();

  for (const table of sortedTables) {
    const rowCount = table.rows.length;
    manifest.tables.push({ name: table.name, rows: rowCount });
    manifest.row_count += rowCount;
    zipData[`tables/${table.name}.json`] = enc.encode(JSON.stringify(table.rows));
  }

  zipData["manifest.json"] = enc.encode(JSON.stringify(manifest));
  const bytes = fflate.zipSync(zipData, { level: 9 });
  return { bytes, manifest };
}

/**
 * يفك ضغط الأرشيف ويتحقق من صحته بشكل شامل قبل السماح بالاستعادة.
 *
 * Rejects:
 * - a missing or unparseable manifest
 * - an unsupported format_version
 * - a duplicate ZIP entry (fflate's object output silently merges them)
 * - total uncompressed size exceeding MAX_UNCOMPRESSED_BYTES (zip-bomb)
 * - a manifest table with no matching data file
 * - a per-table row count disagreeing with the manifest
 * - table data that is not a JSON array
 *
 * Extra unlisted files are ignored to allow additive format changes.
 */
export function readArchive(
  bytes: Uint8Array,
  options: { maxUncompressedBytes?: number } = {},
): {
  manifest: BackupManifest;
  tables: BackupTableData[];
} {
  // السقف قابل للحقن كي يُختبر الحارس على بايتات حقيقية لا على محاكاة.
  //
  // Injectable so the zip-bomb guard can be tested against a real archive with
  // a small ceiling. The alternative was spying on fflate's `unzipSync`, which
  // is not possible for an ESM export and would have tested the mock rather
  // than the guard. Callers get the real ceiling by default.
  const ceiling = options.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES;

  // ── Pre-decompress safety checks via the central directory ──────────
  const zipEntries = scanZipEntries(bytes);

  const seenNames = new Set<string>();
  let totalUncompressed = 0;
  for (const entry of zipEntries) {
    if (seenNames.has(entry.name)) {
      throw new Error(`Invalid archive: duplicate ZIP entry '${entry.name}'`);
    }
    seenNames.add(entry.name);
    totalUncompressed += entry.uncompressedSize;
  }

  if (totalUncompressed > ceiling) {
    throw new Error(
      `Invalid archive: total uncompressed size (${totalUncompressed} bytes) ` +
        `exceeds the ${ceiling} byte safety ceiling`,
    );
  }

  // ── Decompress ──────────────────────────────────────────────────────
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = fflate.unzipSync(bytes);
  } catch (e) {
    throw new Error("Failed to unzip archive: " + (e instanceof Error ? e.message : String(e)), {
      cause: e,
    });
  }

  // ── Post-decompress safety check ────────────────────────────────────
  let actualUncompressed = 0;
  for (const fileBytes of Object.values(unzipped)) {
    actualUncompressed += fileBytes.byteLength;
  }
  if (actualUncompressed > ceiling) {
    throw new Error(
      `Invalid archive: actual uncompressed size (${actualUncompressed} bytes) ` +
        `exceeds the ${ceiling} byte safety ceiling`,
    );
  }

  // ── Parse and validate manifest ─────────────────────────────────────
  const manifestBytes = unzipped["manifest.json"];
  if (!manifestBytes) {
    throw new Error("Invalid archive: missing manifest.json");
  }

  const dec = new TextDecoder();
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(dec.decode(manifestBytes)) as BackupManifest;
  } catch {
    throw new Error("Invalid archive: manifest.json is not valid JSON");
  }

  if (manifest.format_version > BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported archive format version: ${manifest.format_version}`);
  }

  if (!Array.isArray(manifest.tables)) {
    throw new Error("Invalid archive: manifest.tables is not an array");
  }

  for (const entry of manifest.tables as unknown[]) {
    const candidate = entry as { name?: unknown; rows?: unknown } | null;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.name !== "string" ||
      typeof candidate.rows !== "number"
    ) {
      throw new Error(
        "Invalid archive: manifest.tables must contain objects with a string 'name' and a numeric 'rows'",
      );
    }
  }

  // ── Validate and extract each table ─────────────────────────────────
  const tables: BackupTableData[] = [];
  for (const tableMeta of manifest.tables) {
    const tablePath = `tables/${tableMeta.name}.json`;
    const tableBytes = unzipped[tablePath];
    if (!tableBytes) {
      throw new Error(`Invalid archive: missing table data for '${tableMeta.name}'`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(dec.decode(tableBytes));
    } catch {
      throw new Error(`Invalid archive: table '${tableMeta.name}' is not valid JSON`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid archive: table '${tableMeta.name}' data is not an array`);
    }

    if (parsed.length !== tableMeta.rows) {
      throw new Error(
        `Invalid archive: table '${tableMeta.name}' has ${parsed.length} rows ` +
          `but manifest declares ${tableMeta.rows}`,
      );
    }

    tables.push({ name: tableMeta.name, rows: parsed });
  }

  return { manifest, tables };
}

/**
 * ينشئ اسم ملف النسخة الاحتياطية بناءً على وقت الإنشاء بتوقيت الكويت.
 *
 * Asia/Kuwait is UTC+3 year-round with no daylight saving, so a fixed
 * +3 offset is correct and explicitly applied via the shared toKuwaitDate.
 */
export function backupFileName(createdAt: Date): string {
  const kw = toKuwaitDate(createdAt);
  const yyyy = kw.getUTCFullYear();
  const mm = (kw.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = kw.getUTCDate().toString().padStart(2, "0");
  const hh = kw.getUTCHours().toString().padStart(2, "0");
  const min = kw.getUTCMinutes().toString().padStart(2, "0");
  return `backup-${yyyy}-${mm}-${dd}-${hh}${min}.zip`;
}

/**
 * يحسب بصمة SHA-256 بالنظام السداسي العشري لمصفوفة بايتات.
 *
 * Uses the Web Crypto API (globalThis.crypto.subtle) which is available
 * in both the browser and this project's Node/Nitro server runtime, so
 * the module stays environment-neutral without importing node:crypto.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // نسخة جديدة مضمونة الاستناد إلى ArrayBuffer عادي.
  //
  // Not `bytes.buffer`: that is typed ArrayBufferLike, which admits
  // SharedArrayBuffer and so is not a BufferSource — and it would hash the
  // whole underlying buffer rather than this view, silently giving the wrong
  // digest for a subarray. Copying is correct on both counts.
  const view = new Uint8Array(bytes);
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * يحسب مفتاح الفترة الزمنية للنسخ الاحتياطي التلقائي بتوقيت الكويت.
 *
 * Returns "d:YYYY-MM-DD" for daily or "w:YYYY-Www" for weekly, always
 * evaluated against the Kuwait wall clock (UTC+3, no DST). The weekly
 * key uses the ISO 8601 week of the Kuwait-local date — ISO weeks start
 * Monday and the ISO year can differ from the calendar year at year
 * boundaries (e.g. 2027-01-01 belongs to w:2026-W53).
 *
 * Switching frequency mid-period produces a key the database has never
 * seen, so the next tick backs up immediately — the safe direction
 * (an extra archive, never a missed one).
 */
export function periodKeyFor(frequency: BackupFrequency, at: Date): string {
  const kw = toKuwaitDate(at);

  if (frequency === "daily") {
    const yyyy = kw.getUTCFullYear();
    const mm = (kw.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = kw.getUTCDate().toString().padStart(2, "0");
    return `d:${yyyy}-${mm}-${dd}`;
  }

  const { year, week } = isoWeekOf(kw);
  return `w:${year}-W${week.toString().padStart(2, "0")}`;
}

export interface AutoBackupState {
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  /** period_key of the newest automatic backup, or null. */
  lastPeriodKey: string | null;
}

export type BackupDueReason = "disabled" | "already-done" | "due";

/**
 * يقرر ما إذا كان يجب إنشاء نسخة احتياطية تلقائية الآن.
 *
 * Uses Kuwait calendar periods (not elapsed time) so the due decision
 * never drifts. The caller writes the returned periodKey to the backups
 * row, where a partial unique index on (kind, period_key) is the final
 * authority if two ticks race.
 */
export function isBackupDue(
  state: AutoBackupState,
  now: Date,
): { due: boolean; reason: BackupDueReason; periodKey: string | null } {
  if (!state.dailyEnabled && !state.weeklyEnabled) {
    return { due: false, reason: "disabled", periodKey: null };
  }

  // Daily takes precedence when both are enabled — it is the more frequent
  // cycle. The database check constraint forbids both true at once, but
  // defensive code is free.
  const frequency: BackupFrequency = state.dailyEnabled ? "daily" : "weekly";
  const periodKey = periodKeyFor(frequency, now);

  if (state.lastPeriodKey === periodKey) {
    return { due: false, reason: "already-done", periodKey };
  }

  return { due: true, reason: "due", periodKey };
}

/**
 * يحدد النسخ الاحتياطية التي يجب حذفها مع فصل حصص الاحتفاظ حسب النوع.
 *
 * pre_restore archives are counted under keepPreRestore; all others under
 * keep. Returns the rows that exceed each class's allowance, sorted
 * newest-first within each class. Never mutates the input array.
 * A limit <= 0 protects everything in that class (no prune targets).
 */
export function pruneTargets<T extends { created_at: string; kind: BackupKind }>(
  rows: T[],
  limits: { keep: number; keepPreRestore: number },
): T[] {
  const byAge = (a: T, b: T) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime();

  const pruneClass = (group: T[], keep: number): T[] => {
    if (keep <= 0) return [];
    return [...group].sort(byAge).slice(keep);
  };

  const preRestore = rows.filter((r) => r.kind === "pre_restore");
  const regular = rows.filter((r) => r.kind !== "pre_restore");

  return [...pruneClass(regular, limits.keep), ...pruneClass(preRestore, limits.keepPreRestore)];
}
