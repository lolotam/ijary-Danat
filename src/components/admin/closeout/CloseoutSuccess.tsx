import { Link } from "@tanstack/react-router";

import { ModuleHeader } from "@/components/admin/Phase2Ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LtrText } from "@/components/ui/ltr-text";
import { Toaster } from "@/components/ui/sonner";
import { useI18n } from "@/i18n/provider";
import { formatKwd } from "@/lib/money";
import { contractStateTone } from "@/lib/statusTone";
import { num, type CloseoutResult } from "@/components/admin/closeout/closeoutShared";
import type { ContractCloseoutWithLines } from "@/hooks/useContractCloseouts";

/**
 * شاشة ما بعد الإغلاق الناجح: رقم الإغلاق، الاسترداد، حالة العقد، وكشف التسوية.
 */
export function CloseoutSuccess({
  success,
  statementCloseout,
  tenantId,
  onOpenStatement,
}: {
  success: CloseoutResult;
  /** صف الإغلاق مع بنوده، لكشف التسوية؛ null حتى يُحمَّل. */
  statementCloseout: ContractCloseoutWithLines | null | undefined;
  tenantId: string | null;
  onOpenStatement: (closeout: ContractCloseoutWithLines) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader title={t("closeout.successTitle")} subtitle={t("closeout.successSubtitle")} />
      <div className="space-y-4 rounded-xl border bg-card p-6">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-muted-foreground">{t("closeout.closeoutId")}</dt>
            <dd className="font-mono text-sm">
              <LtrText>{success.closeout_id ?? "—"}</LtrText>
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{t("closeout.refundCode")}</dt>
            <dd className="font-mono text-sm">
              <LtrText>{success.refund_code ?? t("common.none")}</LtrText>
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{t("contracts.state")}</dt>
            <dd>
              {success.contract_state ? (
                <Badge variant={contractStateTone(success.contract_state as never)}>
                  {t(`contractState.${success.contract_state}`)}
                </Badge>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{t("closeout.refundTotal")}</dt>
            <dd>
              <LtrText>{formatKwd(num(success.refund_total), locale)}</LtrText>
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            type="button"
            variant="default"
            disabled={!statementCloseout}
            onClick={() => {
              if (statementCloseout) onOpenStatement(statementCloseout);
            }}
          >
            {t("closeout.statement")}
          </Button>
          <Button asChild variant="outline">
            <Link
              to="/admin/contracts"
              search={{ view: "current" } as { view?: "current" | "archived" | "all" }}
            >
              {t("closeout.backToContracts")}
            </Link>
          </Button>
          {tenantId ? (
            <Button asChild variant="outline">
              <Link to="/admin/tenants/$id" params={{ id: tenantId }}>
                {t("closeout.viewTenant")}
              </Link>
            </Button>
          ) : null}
          {success.archived_at ? (
            <Button asChild>
              <Link
                to="/admin/contracts"
                search={{ view: "archived" } as { view?: "current" | "archived" | "all" }}
              >
                {t("archive.viewArchived")}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
