/**
 * ينسخ نصًا مع سقف زمني حتى لا يتجمّد المؤشر إن بقي المستند بلا تركيز.
 *
 * `navigator.clipboard.writeText()` can return a promise that never settles
 * when the document is unfocused. The race puts a ceiling on it.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard timeout")), 2000)),
    ]);
    return true;
  } catch {
    return false;
  }
}
