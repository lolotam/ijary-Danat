import { supabase } from "@/integrations/supabase/client";

/**
 * ينزّل ملفاً من التخزين ويحفظه باسمه المعروض كما هو، بما في ذلك الأسماء العربية.
 *
 * The name is applied through the anchor's `download` attribute, never through
 * the signed URL's `download` query parameter. storage-js 2.111 builds that
 * parameter with URLSearchParams (percent-encoding "شركة" to "%D8%B4…") and
 * then wraps the whole URL in encodeURI, which re-encodes every "%" as "%25".
 * The server decodes once and saves the file under the literal string
 * "%D8%B4…" — which is what admins saw on 2026-09-06. ASCII names survive
 * because they are never encoded in the first place, so the bug only shows
 * for Arabic. The anchor attribute takes the UTF-8 string directly.
 */
export async function downloadStoredFile(
  bucket: string,
  path: string,
  filename: string,
): Promise<void> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 300);
  if (error) throw error;

  const response = await fetch(data.signedUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const link = document.createElement("a");
  link.href = URL.createObjectURL(await response.blob());
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
