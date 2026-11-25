import { describe, it, expect, vi } from "vitest";
import * as fflate from "fflate";
import {
  buildArchive,
  readArchive,
  backupFileName,
  sha256Hex,
  periodKeyFor,
  pruneTargets,
  isBackupDue,
  BACKUP_FORMAT_VERSION,
  type BackupTableData,
  type BackupKind,
} from "./backupArchive";

describe("backupArchive", () => {
  describe("buildArchive and readArchive", () => {
    it("round trips data correctly including empty and arabic tables", () => {
      const inputTables: BackupTableData[] = [
        {
          name: "users",
          rows: [
            { id: 1, name: "أحمد", status: null },
            { id: 2, name: "سارة", status: "active" },
          ],
        },
        {
          name: "empty_table",
          rows: [],
        },
      ];

      const meta = {
        kind: "manual" as BackupKind,
        createdAt: new Date("2026-08-17T10:00:00Z"),
        schemaFingerprint: "mock-schema-hash",
      };

      const { bytes, manifest } = buildArchive(inputTables, meta);
      const parsed = readArchive(bytes);

      expect(parsed.manifest.kind).toBe("manual");
      expect(parsed.manifest.format_version).toBe(BACKUP_FORMAT_VERSION);
      expect(parsed.manifest.row_count).toBe(2);
      expect(parsed.manifest.tables).toHaveLength(2);
      expect(parsed.manifest.schema_fingerprint).toBe("mock-schema-hash");

      // Check sorted order
      expect(parsed.manifest.tables[0].name).toBe("empty_table");
      expect(parsed.manifest.tables[1].name).toBe("users");

      expect(parsed.tables).toHaveLength(2);
      expect(parsed.tables.find((t) => t.name === "empty_table")?.rows).toEqual([]);
      expect(parsed.tables.find((t) => t.name === "users")?.rows).toEqual(inputTables[0].rows);
    });

    it("compresses JSON data effectively", () => {
      const rows = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        someRepeatedField: "this is a repeated string that compresses well",
        anotherField: "also repeated",
      }));

      const { bytes } = buildArchive([{ name: "test", rows }], {
        kind: "automatic",
        createdAt: new Date(),
        schemaFingerprint: "x",
      });

      const rawJson = JSON.stringify(rows);
      const rawSize = new TextEncoder().encode(rawJson).length;

      expect(bytes.length).toBeLessThan(rawSize / 2);
    });

    it("throws on missing manifest", () => {
      const zipData = {
        "tables/some.json": new TextEncoder().encode("[]"),
      };
      const bytes = fflate.zipSync(zipData, { level: 9 });

      expect(() => readArchive(bytes)).toThrowError("Invalid archive: missing manifest.json");
    });

    it("throws on corrupt bytes", () => {
      const badBytes = new Uint8Array([1, 2, 3, 4, 5]);
      expect(() => readArchive(badBytes)).toThrowError(/Failed to unzip archive:/);
    });

    it("throws on format_version: 999", () => {
      const manifest = {
        format_version: 999,
        schema_fingerprint: "x",
        created_at: new Date().toISOString(),
        kind: "manual",
        tables: [],
        row_count: 0,
      };
      const zipData = {
        "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
      };
      const bytes = fflate.zipSync(zipData, { level: 9 });

      expect(() => readArchive(bytes)).toThrowError("Unsupported archive format version: 999");
    });

    it("throws on duplicate ZIP entry", () => {
      const manifest = {
        format_version: BACKUP_FORMAT_VERSION,
        schema_fingerprint: "x",
        created_at: new Date().toISOString(),
        kind: "manual",
        tables: [],
        row_count: 0,
      };

      const zipData = {
        "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
      };
      const validZip = fflate.zipSync(zipData, { level: 0 });

      let eocdOffset = -1;
      for (let i = validZip.length - 22; i >= 0; i--) {
        if (
          validZip[i] === 0x50 &&
          validZip[i + 1] === 0x4b &&
          validZip[i + 2] === 0x05 &&
          validZip[i + 3] === 0x06
        ) {
          eocdOffset = i;
          break;
        }
      }

      const cdOffset =
        (validZip[eocdOffset + 16] |
          (validZip[eocdOffset + 17] << 8) |
          (validZip[eocdOffset + 18] << 16) |
          (validZip[eocdOffset + 19] << 24)) >>>
        0;
      const cdSize =
        (validZip[eocdOffset + 12] |
          (validZip[eocdOffset + 13] << 8) |
          (validZip[eocdOffset + 14] << 16) |
          (validZip[eocdOffset + 15] << 24)) >>>
        0;

      const localFileAndData = validZip.subarray(0, cdOffset);
      const cdEntry = validZip.subarray(cdOffset, cdOffset + cdSize);

      const newCdOffset = cdOffset + localFileAndData.length;
      const newCdSize = cdSize * 2;

      const cdEntry2 = new Uint8Array(cdEntry);
      const oldLocalOffset =
        (cdEntry2[42] | (cdEntry2[43] << 8) | (cdEntry2[44] << 16) | (cdEntry2[45] << 24)) >>> 0;
      const newLocalOffset = oldLocalOffset + localFileAndData.length;
      cdEntry2[42] = newLocalOffset & 0xff;
      cdEntry2[43] = (newLocalOffset >> 8) & 0xff;
      cdEntry2[44] = (newLocalOffset >> 16) & 0xff;
      cdEntry2[45] = (newLocalOffset >> 24) & 0xff;

      const newEocd = new Uint8Array(validZip.subarray(eocdOffset));
      newEocd[8] = 2;
      newEocd[9] = 0;
      newEocd[10] = 2;
      newEocd[11] = 0;

      newEocd[12] = newCdSize & 0xff;
      newEocd[13] = (newCdSize >> 8) & 0xff;
      newEocd[14] = (newCdSize >> 16) & 0xff;
      newEocd[15] = (newCdSize >> 24) & 0xff;

      newEocd[16] = newCdOffset & 0xff;
      newEocd[17] = (newCdOffset >> 8) & 0xff;
      newEocd[18] = (newCdOffset >> 16) & 0xff;
      newEocd[19] = (newCdOffset >> 24) & 0xff;

      const bytes = new Uint8Array(
        localFileAndData.length +
          localFileAndData.length +
          cdEntry.length +
          cdEntry2.length +
          newEocd.length,
      );

      let p = 0;
      bytes.set(localFileAndData, p);
      p += localFileAndData.length;
      bytes.set(localFileAndData, p);
      p += localFileAndData.length;
      bytes.set(cdEntry, p);
      p += cdEntry.length;
      bytes.set(cdEntry2, p);
      p += cdEntry2.length;
      bytes.set(newEocd, p);

      expect(() => readArchive(bytes)).toThrowError(
        "Invalid archive: duplicate ZIP entry 'manifest.json'",
      );
    });

    it("throws on manifest row-count disagreeing with table data", () => {
      const manifest = {
        format_version: BACKUP_FORMAT_VERSION,
        schema_fingerprint: "x",
        created_at: new Date().toISOString(),
        kind: "manual",
        tables: [{ name: "users", rows: 10 }], // Says 10, but we provide 1
        row_count: 10,
      };
      const zipData = {
        "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
        "tables/users.json": new TextEncoder().encode('[{"id":1}]'),
      };
      const bytes = fflate.zipSync(zipData, { level: 9 });

      expect(() => readArchive(bytes)).toThrowError(
        "Invalid archive: table 'users' has 1 rows but manifest declares 10",
      );
    });

    it("throws if uncompressed sizes declared in EOCD exceed ceiling", () => {
      const manifest = {
        format_version: BACKUP_FORMAT_VERSION,
        schema_fingerprint: "x",
        created_at: new Date().toISOString(),
        kind: "manual",
        tables: [],
        row_count: 0,
      };
      const zipData = {
        "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
      };
      const bytes = fflate.zipSync(zipData, { level: 9 });

      // Find central directory entry for manifest.json
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
      const cdOffset =
        (bytes[eocdOffset + 16] |
          (bytes[eocdOffset + 17] << 8) |
          (bytes[eocdOffset + 18] << 16) |
          (bytes[eocdOffset + 19] << 24)) >>>
        0;

      // Hack the uncompressed size to be MAX_UNCOMPRESSED_BYTES + 1
      const hugeSize = 256 * 1024 * 1024 + 1;
      bytes[cdOffset + 24] = hugeSize & 0xff;
      bytes[cdOffset + 25] = (hugeSize >> 8) & 0xff;
      bytes[cdOffset + 26] = (hugeSize >> 16) & 0xff;
      bytes[cdOffset + 27] = (hugeSize >> 24) & 0xff;

      expect(() => readArchive(bytes)).toThrowError(
        /Invalid archive: total uncompressed size.*exceeds the.*safety ceiling/,
      );
    });

    it("throws if actual decompressed data exceeds ceiling, even if declared size is small", () => {
      const manifest = {
        format_version: BACKUP_FORMAT_VERSION,
        schema_fingerprint: "x",
        created_at: new Date().toISOString(),
        kind: "manual",
        tables: [],
        row_count: 0,
      };
      const zipData = {
        "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
      };
      const bytes = fflate.zipSync(zipData, { level: 9 });

      // A real archive, a small ceiling. Spying on fflate's `unzipSync` is
      // impossible for an ESM export, and would have tested the mock rather
      // than the guard — so the ceiling is injected and the guard runs against
      // genuine decompressed bytes.
      expect(() => readArchive(bytes, { maxUncompressedBytes: 8 })).toThrowError(
        /uncompressed size .* exceeds the 8 byte safety ceiling/,
      );

      // And it passes under a ceiling that genuinely fits.
      expect(() => readArchive(bytes)).not.toThrow();
    });

    it("throws when a table entry is not an array", () => {
      const manifest = {
        format_version: BACKUP_FORMAT_VERSION,
        schema_fingerprint: "x",
        created_at: new Date().toISOString(),
        kind: "manual",
        tables: [{ name: "users", rows: 1 }],
        row_count: 1,
      };
      const zipData = {
        "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
        "tables/users.json": new TextEncoder().encode('{"id":1}'),
      };
      const bytes = fflate.zipSync(zipData, { level: 9 });

      expect(() => readArchive(bytes)).toThrowError(
        "Invalid archive: table 'users' data is not an array",
      );
    });

    it("ignores an unlisted extra file inside the ZIP", () => {
      const { bytes } = buildArchive([], {
        kind: "manual",
        createdAt: new Date(),
        schemaFingerprint: "x",
      });

      // Unzip, add file, re-zip
      const unzipped = fflate.unzipSync(bytes);
      unzipped["extra_file.txt"] = new TextEncoder().encode("hello");
      const rezipped = fflate.zipSync(unzipped, { level: 9 });

      const parsed = readArchive(rezipped);
      expect(parsed.tables).toEqual([]);
    });
  });

  describe("sha256Hex", () => {
    it("computes correct hash against known vector", async () => {
      // SHA-256 of "hello" is 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      const input = new TextEncoder().encode("hello");
      const hash = await sha256Hex(input);
      expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    });

    it("produces different hashes for different inputs", async () => {
      const h1 = await sha256Hex(new TextEncoder().encode("hello"));
      const h2 = await sha256Hex(new TextEncoder().encode("world"));
      expect(h1).not.toBe(h2);
    });
  });

  describe("backupFileName", () => {
    it("produces correct filename with Kuwait wall-clock", () => {
      // 2026-08-16T22:30:00Z in UTC is 2026-08-17T01:30:00 in Kuwait (+3)
      const date = new Date("2026-08-16T22:30:00Z");
      const filename = backupFileName(date);
      expect(filename).toBe("backup-2026-08-17-0130.zip");
    });
  });

  describe("periodKeyFor", () => {
    it("handles daily across UTC/Kuwait day boundary", () => {
      // 2026-08-16T22:30:00Z is 2026-08-17T01:30:00 in Kuwait (+3)
      const at = new Date("2026-08-16T22:30:00Z");
      expect(periodKeyFor("daily", at)).toBe("d:2026-08-17");
    });

    it("handles weekly across an ISO-year boundary", () => {
      // 2027-01-01T10:00:00Z is a Friday in Kuwait. The Thursday was 2026-12-31.
      // So ISO year is 2026, week 53.
      const at = new Date("2027-01-01T10:00:00Z");
      expect(periodKeyFor("weekly", at)).toBe("w:2026-W53");
    });
  });

  describe("pruneTargets", () => {
    const rows = [
      { id: 1, created_at: "2026-08-10T10:00:00Z", kind: "manual" as BackupKind },
      { id: 2, created_at: "2026-08-12T10:00:00Z", kind: "automatic" as BackupKind },
      { id: 3, created_at: "2026-08-15T10:00:00Z", kind: "manual" as BackupKind }, // Newest regular

      { id: 4, created_at: "2026-08-11T10:00:00Z", kind: "pre_restore" as BackupKind },
      { id: 5, created_at: "2026-08-14T10:00:00Z", kind: "pre_restore" as BackupKind }, // Newest pre_restore
    ];

    it("honours keep and keepPreRestore separately", () => {
      const targets = pruneTargets(rows, { keep: 1, keepPreRestore: 1 });
      // Regular: keeps id 3 (newest), so id 2 and id 1 are targets.
      // Pre_restore: keeps id 5 (newest), so id 4 is a target.
      expect(targets).toHaveLength(3);
      expect(targets.map((t) => t.id)).toEqual(expect.arrayContaining([1, 2, 4]));
      expect(targets.map((t) => t.id)).not.toContain(3);
      expect(targets.map((t) => t.id)).not.toContain(5);
    });

    it("does not mutate input array", () => {
      const copy = [...rows];
      pruneTargets(rows, { keep: 1, keepPreRestore: 1 });
      expect(rows).toEqual(copy);
    });
  });

  describe("isBackupDue", () => {
    it("returns disabled when neither switch is on", () => {
      const state = { dailyEnabled: false, weeklyEnabled: false, lastPeriodKey: null };
      expect(isBackupDue(state, new Date())).toEqual({
        due: false,
        reason: "disabled",
        periodKey: null,
      });
    });

    it("returns due when daily fresh (lastPeriodKey null)", () => {
      const state = { dailyEnabled: true, weeklyEnabled: false, lastPeriodKey: null };
      const now = new Date("2026-08-17T10:00:00Z");
      expect(isBackupDue(state, now)).toEqual({
        due: true,
        reason: "due",
        periodKey: "d:2026-08-17",
      });
    });

    it("returns already-done when daily already-done", () => {
      const state = { dailyEnabled: true, weeklyEnabled: false, lastPeriodKey: "d:2026-08-17" };
      const now = new Date("2026-08-17T10:00:00Z");
      expect(isBackupDue(state, now)).toEqual({
        due: false,
        reason: "already-done",
        periodKey: "d:2026-08-17",
      });
    });

    it("returns due when daily due (different day)", () => {
      const state = { dailyEnabled: true, weeklyEnabled: false, lastPeriodKey: "d:2026-08-16" };
      const now = new Date("2026-08-17T10:00:00Z");
      expect(isBackupDue(state, now)).toEqual({
        due: true,
        reason: "due",
        periodKey: "d:2026-08-17",
      });
    });

    it("returns due when weekly fresh (lastPeriodKey null)", () => {
      const state = { dailyEnabled: false, weeklyEnabled: true, lastPeriodKey: null };
      const now = new Date("2026-08-17T10:00:00Z"); // Kuwait: 2026-08-17 (Monday) -> w:2026-W34
      expect(isBackupDue(state, now)).toEqual({
        due: true,
        reason: "due",
        periodKey: "w:2026-W34",
      });
    });

    it("returns already-done when weekly already-done", () => {
      const state = { dailyEnabled: false, weeklyEnabled: true, lastPeriodKey: "w:2026-W34" };
      const now = new Date("2026-08-17T10:00:00Z");
      expect(isBackupDue(state, now)).toEqual({
        due: false,
        reason: "already-done",
        periodKey: "w:2026-W34",
      });
    });

    it("treats as daily when both switches on", () => {
      const state = { dailyEnabled: true, weeklyEnabled: true, lastPeriodKey: "d:2026-08-17" };
      const now = new Date("2026-08-17T10:00:00Z");
      expect(isBackupDue(state, now)).toEqual({
        due: false,
        reason: "already-done",
        periodKey: "d:2026-08-17",
      });
    });
  });
});
