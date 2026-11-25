import { useTypewriter } from "@/hooks/useTypewriter";

type TypedTextProps = {
  /** النص الكامل المطلوب كتابته حرفًا بحرف. */
  text: string;
  /** المدة بين كل حرفين بالمللي ثانية. */
  speedMs?: number;
  /** تأخير البدء بالمللي ثانية. */
  startDelayMs?: number;
  /** إظهار مؤشر الكتابة الوامض بعد النص. */
  withCursor?: boolean;
};

/**
 * يكتب نصًا حرفًا بحرف مع إبقاء النص الكامل متاحًا لقارئات الشاشة ومحرّكات البحث.
 *
 * The animation state lives here rather than in the page component on purpose:
 * `useTypewriter` sets state once per character, and holding it any higher
 * re-rendered the entire landing page ~65 times during hydration. The
 * `sr-only` sibling is not decoration — the animated span starts empty, so it
 * is the only copy of the heading a crawler or screen reader ever sees.
 */
export function TypedText({ text, speedMs, startDelayMs, withCursor = false }: TypedTextProps) {
  const typed = useTypewriter(text, speedMs, startDelayMs);

  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{typed}</span>
      {withCursor ? (
        <span
          aria-hidden="true"
          className="ms-1 inline-block w-[3px] animate-pulse bg-[#d4af37] align-middle text-transparent motion-reduce:animate-none"
        >
          |
        </span>
      ) : null}
    </>
  );
}
