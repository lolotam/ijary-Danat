import { useEffect, useState } from "react";

/**
 * ينشئ رابط كائن (object URL) لـ Blob ويُلغيه عند تغييره أو إزالة المكوّن.
 *
 * يضمن عدم تسريب الذاكرة عند فتح عشرات المعاينات في خيط واحد؛ كل رابط
 * مرتبط بدورة حياة الـ Blob الذي أنتجه خطاف الوسائط.
 */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [blob]);

  return url;
}
