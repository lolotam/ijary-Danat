/**
 * يبني اسم ملف التنزيل من الاسم المعروض مع امتداد الملف المخزَّن الحقيقي.
 *
 * Uploaded objects are stored under `crypto.randomUUID().<ext>` leaves, so a
 * signed URL with a bare `download: true` saves as the UUID — the admin gets
 * "1f2f9c33-….pdf" instead of the document's name. The display name is the
 * human name, but it is admin-typed and often extension-less; the extension
 * must come from the stored object's path so the saved file still opens.
 */
export function documentDownloadName(
  displayName: string | null | undefined,
  storagePath: string | null | undefined,
  fallback = "document",
): string {
  const base = (displayName ?? "").replace(/[/\\]/g, "_").trim() || fallback;
  const leaf = (storagePath ?? "").split("/").pop() ?? "";
  const dot = leaf.lastIndexOf(".");
  const extension = dot > 0 ? leaf.slice(dot + 1).toLowerCase() : "";
  if (!extension) return base;
  return base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
}
