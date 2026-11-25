import { useMemo, useState, type JSX } from "react";

import { TenantOptionLabel } from "@/components/admin/TenantOptionLabel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTenants } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import { appendAddresses } from "@/lib/addressList";
import { isContractEnded, tenantDisplayName } from "@/lib/tenantDisplayName";
import { cn } from "@/lib/utils";

/**
 * يضع العناوين المضافة في حقل «إلى» حتى تظهر في الحقل الأول ويمكن تعديلها.
 *
 * Staff pick tenants to see and edit the list in To. Bcc stays available
 * from the Cc/Bcc toggle when they want recipients hidden from each other.
 */
export function routeAddition(_addresses: string[]): { field: "to" | "bcc" } {
  return { field: "to" };
}

/**
 * يعيد البريد بعد قص المسافات، أو سلسلة فارغة إن لم يكن للمستأجر بريد.
 *
 * Whitespace-only is treated as missing so a disabled row cannot be added
 * as a blank token that later looks like a typed draft.
 */
function tenantEmail(tenant: { email?: string | null }): string {
  return tenant.email?.trim() ?? "";
}

/**
 * يضيف العناوين إلى حقل to أو bcc عبر النص الحالي دون نسخة موازية في الحالة.
 */
function mergeIntoHeaders(
  current: { to: string; bcc: string },
  additions: string[],
): { to: string; bcc: string } {
  const emails = additions.filter(Boolean);
  if (emails.length === 0) return current;
  const { field } = routeAddition(emails);
  return {
    to: field === "to" ? appendAddresses(current.to, emails) : current.to,
    bcc: field === "bcc" ? appendAddresses(current.bcc, emails) : current.bcc,
  };
}

/**
 * قائمة اختيار مستأجرين تُعرض بجانب حقل «إلى» في نافذة إنشاء الرسالة.
 *
 * Addresses live only in the `to` / `bcc` strings. Ticked rows inside the
 * open popover are a transient UI selection, not a second copy of the
 * recipients — that parallel array is what resurrects a deleted address.
 */
export function ComposeRecipients({
  to,
  bcc,
  onChange,
}: {
  to: string;
  bcc: string;
  onChange: (next: { to: string; bcc: string }) => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  // Deferred until the popover is actually opened. The trigger renders on every
  // compose, reply and forward; fetching a thousand tenants each time to
  // populate a list nobody has asked for is work the mailbox does not need.
  // `TenantMultiSelect` takes the same `enabled` argument for this reason.
  const tenantsQuery = useTenants({ pageSize: 1000 }, open);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const items = tenantsQuery.data?.items;
  const withEmailCount = (items ?? []).filter((tenant) => tenantEmail(tenant)).length;
  const totalCount = items?.length ?? 0;

  const visibleTenants = useMemo(() => {
    const tenants = items ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return tenants;
    return tenants.filter((tenant) =>
      [tenant.name, tenant.name_en ?? "", tenant.code ?? "", tenant.email ?? ""].some((field) =>
        field.toLowerCase().includes(needle),
      ),
    );
  }, [search, items]);

  /**
   * يبدّل تحديد صف المستأجر داخل النافذة المنبثقة فقط.
   */
  function toggleTenant(tenantId: string, checked: boolean) {
    setSelectedIds((current) =>
      checked ? [...current, tenantId] : current.filter((id) => id !== tenantId),
    );
  }

  /**
   * يضيف عناوين الصفوف المحددة إلى الحقل المناسب عبر النص الحالي.
   */
  function addSelected() {
    const picked = (items ?? []).filter((tenant) => selectedIds.includes(tenant.id));
    onChange(mergeIntoHeaders({ to, bcc }, picked.map(tenantEmail)));
  }

  /**
   * يضيف كل المستأجرين الظاهرين الذين لديهم بريد — نفس مسار «إضافة المحدد».
   */
  function selectAllVisible() {
    const eligible = visibleTenants.filter((tenant) => tenantEmail(tenant));
    setSelectedIds(eligible.map((tenant) => tenant.id));
    onChange(mergeIntoHeaders({ to, bcc }, eligible.map(tenantEmail)));
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          {t("inbox.pickTenants")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="flex min-h-0 flex-col gap-2">
          <Input
            value={search}
            placeholder={t("inbox.pickTenantsSearch")}
            onChange={(event) => setSearch(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("inbox.tenantsWithEmail")
              .replace("{with}", String(withEmailCount))
              .replace("{total}", String(totalCount))}
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={addSelected}>
              {t("inbox.addSelected")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={selectAllVisible}>
              {t("users.selectAll")}
            </Button>
          </div>
          <div className="max-h-64 min-h-0 flex-1 overflow-y-auto rounded-lg border">
            {tenantsQuery.isLoading ? (
              <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : !visibleTenants.length ? (
              <p className="p-4 text-sm text-muted-foreground">{t("inbox.pickTenantsEmpty")}</p>
            ) : (
              visibleTenants.map((tenant, index) => {
                const email = tenantEmail(tenant);
                const hasEmail = Boolean(email);
                return (
                  <label
                    key={tenant.id}
                    className={cn(
                      "flex items-center gap-3 border-b p-3 last:border-b-0 hover:bg-muted/50",
                      hasEmail ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                    )}
                  >
                    <Checkbox
                      checked={selectedIds.includes(tenant.id)}
                      disabled={!hasEmail}
                      onCheckedChange={(checked) => toggleTenant(tenant.id, checked === true)}
                    />
                    <span className="min-w-0 flex-1">
                      <TenantOptionLabel index={index} ended={isContractEnded(tenant)}>
                        <span className="text-sm font-medium">
                          {tenantDisplayName(tenant, locale)}
                        </span>
                      </TenantOptionLabel>
                      {tenant.code ? (
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {tenant.code}
                        </span>
                      ) : null}
                      {!hasEmail ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {t("inbox.tenantNoEmail")}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
