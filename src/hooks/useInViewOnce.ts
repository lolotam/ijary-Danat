import { useEffect, useState, type RefObject } from "react";

/**
 * يراقب عنصراً ويُثبّت true عند أول ظهور في منطقة العرض.
 *
 * يمنع الجلب المبكّر لكل المرفقات عند فتح الخيط (الحد 10MB للملف)؛
 * يُستخدم كبوابة enabled لخطاف الوسائط. إن لم يتوفر IntersectionObserver
 * (اختبارات jsdom أو متصفح قديم) يعود true فوراً حتى لا يعلق التحميل.
 */
export function useInViewOnce<T extends Element>(ref: RefObject<T | null>): boolean {
  const [visible, setVisible] = useState(() => {
    if (typeof IntersectionObserver === "undefined") return true;
    return false;
  });

  useEffect(() => {
    if (visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, visible]);

  return visible;
}
