import { useEffect, useState } from "react";

/**
 * أول يوم من الشهر التقويمي الحالي بتوقيت آسيا/الكويت، بصيغة YYYY-MM-01.
 *
 * The monthly-totals RPC (and its react-query key) must roll over on the
 * Kuwait calendar month, not UTC. Kuwait is UTC+3 year-round, so a UTC
 * date near midnight on the 1st would otherwise keep serving last month.
 */
export function currentPeriodStart(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuwait",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) {
    throw new Error("Could not resolve the Kuwait calendar month.");
  }
  return `${year}-${month}-01`;
}

/**
 * يعيد بداية الشهر الحالي ويُحدّثها عند حلول شهر جديد دون إعادة تحميل الصفحة.
 *
 * A dashboard left open across midnight on the first of a Kuwait month would
 * otherwise keep the previous month's key forever: nothing re-renders merely
 * because time passed. The timer fires once at the boundary, and a tab woken
 * from sleep re-checks on focus rather than waiting for a stale timer.
 */
export function useCurrentPeriodStart(): string {
  const [periodStart, setPeriodStart] = useState(currentPeriodStart);

  useEffect(() => {
    let timer = 0;
    const syncAt = (now: Date) => setPeriodStart(currentPeriodStart(now));
    // Listeners receive an Event as their first argument, so they get their
    // own zero-argument wrapper rather than a defaulted parameter.
    const sync = () => syncAt(new Date());
    /**
     * يجدول الاستيقاظ التالي، ويقسّم الانتظار الطويل إلى قطع يقبلها المتصفح.
     *
     * setTimeout takes a 32-bit signed delay: anything past ~24.9 days fires
     * IMMEDIATELY, and since sync would then set the same month, this effect
     * would not re-run and no timer would be left armed. Each chunk therefore
     * re-arms the next, and syncs first — a device that slept through the
     * boundary may resume without ever emitting focus or visibilitychange, so
     * the month has to be re-read here rather than waited for again.
     *
     * One clock sample serves both: reading the clock twice around the
     * boundary could pair the OLD month with the NEXT month's delay, leaving
     * the totals stale for a chunk.
     */
    const arm = () => {
      const now = new Date();
      syncAt(now);
      const remaining = msUntilNextKuwaitMonth(now);
      timer = window.setTimeout(
        remaining <= MAX_TIMER_DELAY_MS ? sync : arm,
        Math.min(remaining, MAX_TIMER_DELAY_MS),
      );
    };
    arm();
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [periodStart]);

  return periodStart;
}

/** أقصى تأخير يقبله setTimeout قبل أن ينفّذ فوراً (عدد صحيح 32-بت). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * المللي ثانية المتبقية حتى أول الشهر التالي بتوقيت الكويت، بحد أدنى دقيقة.
 */
export function msUntilNextKuwaitMonth(now = new Date()): number {
  const [year, month] = currentPeriodStart(now).split("-").map(Number);
  // Kuwait is UTC+3 year-round, so the next month starts at 21:00 UTC on the
  // last day of this one; Date.UTC rolls month 12 into the next January.
  const nextMonthStartUtc = Date.UTC(year!, month!, 1, -3);
  return Math.max(60_000, nextMonthStartUtc - now.getTime());
}
