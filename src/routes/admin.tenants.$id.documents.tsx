import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, FileText } from "lucide-react";

import { TenantDocumentsManager } from "@/components/admin/TenantDocumentsManager";
import { Badge } from "@/components/ui/badge";
import { LtrText } from "@/components/ui/ltr-text";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCompany } from "@/hooks/useCompany";
import { useTenant } from "@/hooks/useTenants";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import { PERMISSIONS } from "@/lib/permissions";

export const Route = createFileRoute("/admin/tenants/$id/documents")({
  component: TenantDocumentsPage,
});

function TenantDocumentsPage() {
  const { id } = Route.useParams();
  const { t } = useI18n();
  const permissions = usePermissions();
  const tenant = useTenant(id);
  const company = useCompany();

  if (!permissions.can(PERMISSIONS.TENANTS_READ)) {
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.notAuthorized")}</p>
    );
  }

  if (tenant.isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">{t("common.loading")}</p>;
  }
  if (!tenant.data) {
    return <p className="p-6 text-sm text-destructive">{t("common.notFound")}</p>;
  }

  const tenantLabel = tenant.data.code
    ? `${tenant.data.code} · ${tenant.data.name}`
    : tenant.data.name;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Button asChild variant="ghost" size="sm" className="-ms-2">
            <Link to="/admin/tenants/$id" params={{ id }}>
              <ArrowLeft className="size-4" />
              {t("common.back")}
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold">{t("tenants.documents")}</h1>
          <p className="text-sm text-muted-foreground">{tenantLabel}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tenant.data.mobile ? (
            <Badge variant="outline" className="gap-1">
              <FileText className="size-3" />
              <LtrText>{tenant.data.mobile}</LtrText>
            </Badge>
          ) : null}
          {tenant.data.email ? (
            <Badge variant="outline">
              <LtrText>{tenant.data.email}</LtrText>
            </Badge>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("tenants.documents")}</CardTitle>
        </CardHeader>
        <CardContent>
          <TenantDocumentsManager
            tenantId={id}
            companyId={company.data?.id ?? null}
            tenant={tenant.data}
            enableShare
          />
        </CardContent>
      </Card>
    </div>
  );
}
