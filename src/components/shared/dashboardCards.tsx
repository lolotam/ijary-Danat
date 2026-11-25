import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { translatorFor } from "@/i18n/dictionary";

/**
 * Shared colorful dashboard primitives.
 *
 * These were originally inlined in `src/routes/admin.index.tsx` and are now
 * extracted so the tenant portal can reuse the exact same visual language
 * (vibrant gradient KPI cards + solid-color status badges). Behavior and
 * class names are unchanged from the admin source of truth.
 */

interface VibrantKpiCardProps {
  label: string;
  value: ReactNode;
  hint?: string;
  icon: ReactNode;
  bgClass: string;
  href?: string;
  progressBar?: { current: number; total: number };
}

export function VibrantKpiCard({
  label,
  value,
  hint,
  icon,
  bgClass,
  href,
  progressBar,
}: VibrantKpiCardProps) {
  const percent =
    progressBar && progressBar.total > 0
      ? Math.min(100, Math.round((progressBar.current / progressBar.total) * 100))
      : null;

  const inner = (
    <div
      className={`group relative flex h-full flex-col justify-between overflow-hidden rounded-2xl p-6 text-white transition-all duration-300 hover:-translate-y-1 hover:shadow-xl ${bgClass}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[18px] font-semibold tracking-wide text-white/90 uppercase">{label}</p>
          <div className="mt-2 truncate text-[42px] font-black leading-none tracking-tight drop-shadow-sm">
            {value}
          </div>
          {hint && <p className="mt-1.5 text-[18px] text-white/80 font-medium">{hint}</p>}
        </div>
        <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white/15 p-2.5 backdrop-blur-md border border-white/20 shadow-inner transition-transform duration-300 group-hover:scale-110">
          {icon}
        </div>
      </div>

      {percent !== null ? (
        <div className="mt-4 pt-2">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-black/20 p-0.5 backdrop-blur-sm">
            <div
              className="h-full rounded-full bg-white transition-all duration-500 shadow-sm"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="mt-4 pt-2 opacity-0 pointer-events-none" aria-hidden="true">
          <div className="h-2.5 w-full" />
        </div>
      )}
    </div>
  );

  return href ? <Link to={href}>{inner}</Link> : inner;
}

const STATUS_BADGE_BASE =
  "inline-flex items-center justify-center min-w-[95px] h-7 px-3.5 py-1 text-xs font-bold rounded-full text-white shadow-xs text-center transition-all";

export function PaymentMethodBadge({ method, locale }: { method?: string; locale: string }) {
  if (!method) return null;
  const t = translatorFor(locale);
  const m = method.toLowerCase();
  let label = method;
  let bgClass = "bg-slate-600 text-white";

  if (m === "knet") {
    label = t("dashboardCards.knet");
    bgClass = "bg-blue-600 text-white border-blue-400 shadow-blue-500/30";
  } else if (m === "cash") {
    label = t("dashboardCards.cash");
    bgClass = "bg-emerald-600 text-white border-emerald-400 shadow-emerald-500/30";
  } else if (m === "bank_transfer") {
    label = t("dashboardCards.bankTransfer");
    bgClass = "bg-indigo-600 text-white border-indigo-400 shadow-indigo-500/30";
  } else if (m === "cheque") {
    label = t("dashboardCards.cheque");
    bgClass = "bg-amber-600 text-white border-amber-400 shadow-amber-500/30";
  } else if (m === "payment_link") {
    label = t("dashboardCards.paymentLink");
    bgClass = "bg-fuchsia-600 text-white border-fuchsia-400 shadow-fuchsia-500/30";
  }

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full border px-2.5 py-0.5 text-xs font-extrabold shadow-xs transition-transform hover:scale-105 ${bgClass}`}
    >
      {label}
    </span>
  );
}

export function InvoiceStatusBadge({ state, locale }: { state: string; locale: string }) {
  const t = translatorFor(locale);
  if (state === "overdue") {
    return (
      <span
        className={`${STATUS_BADGE_BASE} bg-red-600 font-extrabold shadow-md shadow-red-500/40 ring-2 ring-red-400/60 animate-pulse`}
      >
        <span className="me-1.5 size-2 rounded-full bg-white animate-ping" />
        {t("dashboardCards.overdue")}
      </span>
    );
  }
  if (state === "paid") {
    return (
      <span className={`${STATUS_BADGE_BASE} bg-emerald-600`}>{t("dashboardCards.paid")}</span>
    );
  }
  if (state === "partially_paid") {
    return (
      <span className={`${STATUS_BADGE_BASE} bg-purple-600`}>
        {t("dashboardCards.partiallyPaid")}
      </span>
    );
  }
  if (state === "due") {
    return <span className={`${STATUS_BADGE_BASE} bg-amber-500`}>{t("dashboardCards.due")}</span>;
  }
  if (state === "cancelled") {
    return (
      <span className={`${STATUS_BADGE_BASE} bg-slate-500`}>{t("dashboardCards.cancelled")}</span>
    );
  }
  if (state === "waived") {
    return <span className={`${STATUS_BADGE_BASE} bg-blue-500`}>{t("dashboardCards.waived")}</span>;
  }
  return <span className={`${STATUS_BADGE_BASE} bg-slate-600`}>{state}</span>;
}

export function PaymentStatusBadge({
  status,
  method,
  locale,
}: {
  status: string;
  method: string;
  locale: string;
}) {
  const t = translatorFor(locale);
  if (status === "reversed" || status === "overdue") {
    return (
      <span
        className={`${STATUS_BADGE_BASE} bg-red-600 font-extrabold shadow-md shadow-red-500/40 ring-2 ring-red-400/60 animate-pulse`}
      >
        <span className="me-1.5 size-2 rounded-full bg-white animate-ping" />
        {t("dashboardCards.reversed")}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className={`${STATUS_BADGE_BASE} bg-emerald-600`}>{t("dashboardCards.paid")}</span>
      <PaymentMethodBadge method={method} locale={locale} />
    </div>
  );
}
