/** Safe filename fragment for reports / invoices. */
export function safeFilename(value: string): string {
  return (
    value
      .trim()
      .replace(/[^\w\u0600-\u06FF-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 80) || "document"
  );
}
