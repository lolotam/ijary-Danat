/**
 * Which archive slice a list or summary query should return.
 *
 * - `current`  — archived_at is null (default; every existing call site)
 * - `archived` — archived_at is not null
 * - `all`      — no archive filter
 *
 * MUST be part of the React Query key params object, or switching tabs serves a
 * cached list from the wrong mode.
 */
export type ArchiveMode = "current" | "archived" | "all";

export const DEFAULT_ARCHIVE_MODE: ArchiveMode = "current";
