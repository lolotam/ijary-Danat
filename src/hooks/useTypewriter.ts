import { useEffect, useState } from "react";

/**
 * Types `text` out one character at a time.
 *
 * Respects `prefers-reduced-motion`: the full string is returned immediately
 * when the viewer has asked for less motion.
 */
export function useTypewriter(text: string, speedMs = 55, startDelayMs = 0): string {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setTyped(text);
      return;
    }

    setTyped("");
    let index = 0;
    let interval: ReturnType<typeof setInterval>;
    const timeout = setTimeout(() => {
      interval = setInterval(() => {
        index += 1;
        setTyped(text.slice(0, index));
        if (index >= text.length) clearInterval(interval);
      }, speedMs);
    }, startDelayMs);

    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [text, speedMs, startDelayMs]);

  return typed;
}
