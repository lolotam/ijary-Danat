import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/i18n/provider";
import { tenantLifecycleTone } from "@/lib/statusTone";

/**
 * سطر خيار مستأجر في القوائم المنسدلة: ترقيم تسلسلي ثم الاسم، وشارة
 * "انتهى العقد" بجانبه عندما تكون `ended` صحيحة.
 *
 * One component so all ten tenant lists number and badge identically: the
 * number is the option's position in the list as shown (`index + 1`), and the
 * badge reuses the tenants table's own lifecycle tone and label rather than
 * inventing a second visual language for the same state.
 */
export function TenantOptionLabel({
  index,
  ended,
  children,
}: {
  /** Zero-based position in the displayed list; rendered as `index + 1`. */
  index: number;
  /** Shows the contract-ended badge next to the name when true. */
  ended: boolean;
  /** The option's existing label text (name, code, suffixes). */
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">
        {index + 1}. {children}
      </span>
      {ended ? (
        <Badge variant={tenantLifecycleTone("contract_ended")} className="shrink-0">
          {t("tenantLifecycle.contract_ended")}
        </Badge>
      ) : null}
    </span>
  );
}
