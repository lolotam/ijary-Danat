import { useEffect, useState } from "react";

/** مهلة البحث الافتراضية: ثانية واحدة بعد آخر ضغطة مفتاح. */
export const SEARCH_DEBOUNCE_MS = 1000;

/**
 * يُرجع القيمة بعد أن تبقى ثابتة طوال المهلة المحددة، ويعيد العدّ عند كل تغيير.
 *
 * Search inputs keep their own state so typing stays responsive; only the value
 * this hook returns goes into query keys, so the network sees one request after
 * the user stops typing instead of one per keystroke.
 */
export function useDebounce<T>(value: T, delay = SEARCH_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
