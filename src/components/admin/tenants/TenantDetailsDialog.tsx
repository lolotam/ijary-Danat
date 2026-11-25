import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";

import { TenantDocumentsManager } from "@/components/admin/TenantDocumentsManager";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Tenant } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import { tenantDisplayName } from "@/lib/tenantDisplayName";

/**
 * حوار تفاصيل سريع للمستأجر: الملف الشخصي ومدير المستندات.
 */
export function TenantDetails({
  tenant,
  companyId,
  close,
}: {
  tenant: Tenant | null;
  companyId: string | null;
  close: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <Dialog open={Boolean(tenant)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tenant ? tenantDisplayName(tenant, locale) : null}</DialogTitle>
          <DialogDescription>{tenant?.code}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="documents">
          <TabsList>
            <TabsTrigger value="profile">{t("tenants.profile")}</TabsTrigger>
            <TabsTrigger value="documents">{t("tenants.documents")}</TabsTrigger>
          </TabsList>
          <TabsContent value="profile" className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
            <p>
              {t("tenants.mobile")}: {tenant?.mobile ?? "—"}
            </p>
            <p>
              {t("tenants.email")}: {tenant?.email ?? "—"}
            </p>
            <p>
              {t("tenants.category")}: {tenant ? t(`tenantCategory.${tenant.category}`) : "—"}
            </p>
            <p>
              {t("tenants.lifecycle")}: {tenant ? t(`tenantLifecycle.${tenant.lifecycle}`) : "—"}
            </p>
          </TabsContent>
          <TabsContent value="documents" className="space-y-4">
            {tenant ? (
              <>
                <div className="flex justify-end">
                  <Button asChild variant="outline" size="sm">
                    <Link
                      to="/admin/tenants/$id/documents"
                      params={{ id: tenant.id }}
                      onClick={close}
                    >
                      <ExternalLink className="size-4" />
                      {t("tenants.openDocumentsPage")}
                    </Link>
                  </Button>
                </div>
                <TenantDocumentsManager
                  tenantId={tenant.id}
                  companyId={companyId}
                  tenant={tenant}
                />
              </>
            ) : null}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
