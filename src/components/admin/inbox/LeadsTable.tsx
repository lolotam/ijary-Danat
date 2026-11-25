import { Building, Mail, Phone, Trash2 } from "lucide-react";

import { Pager, TableState } from "@/components/admin/Phase2Ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { LtrText } from "@/components/ui/ltr-text";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LeasingInquiry } from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";

/**
 * The lead workflow states. Fixed by the DB — `leasing_inquiries.status` carries
 * `check (status in ('new','contacted','accepted','rejected'))`
 * (db/migrations/19_landing_page.sql:131), so anything else fails at write time.
 */
const LEAD_STATUSES = ["new", "contacted", "accepted", "rejected"] as const;
type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * جدول طلبات التأجير (العملاء المحتملين) في صندوق الوارد.
 *
 * Extracted from admin.inbox.tsx, which was 1249 lines. Behaviour is unchanged.
 */
export function LeadsTable({
  canManage,
  selectedLeadIds,
  setDeleteLeadIds,
  leadsLoading,
  leadsError,
  leadItems,
  toggleAllLeads,
  toggleLeadId,
  highlightId,
  dateFormatter,
  updateLeadStatus,
  updateLeadPending,
  leadPage,
  setLeadPage,
  inboxPageSize,
  leadsCount,
}: {
  /** landing_page.leasing_update — status changes and deletes. */
  canManage: boolean;
  selectedLeadIds: Set<string>;
  setDeleteLeadIds: (ids: string[]) => void;
  leadsLoading: boolean;
  leadsError: boolean;
  leadItems: LeasingInquiry[];
  toggleAllLeads: () => void;
  toggleLeadId: (id: string) => void;
  highlightId?: string;
  dateFormatter: Intl.DateTimeFormat;
  updateLeadStatus: (id: string, status: LeadStatus) => void;
  updateLeadPending: boolean;
  leadPage: number;
  setLeadPage: (page: number) => void;
  inboxPageSize: number;
  leadsCount: number;
}) {
  const { t } = useI18n();

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{t("inbox.leasingLeads")}</CardTitle>
          <CardDescription>{t("inbox.subtitle")}</CardDescription>
        </div>
        {canManage && selectedLeadIds.size > 0 ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setDeleteLeadIds([...selectedLeadIds])}
          >
            <Trash2 className="size-4" />
            {t("inbox.deleteSelected")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        <TableState loading={leadsLoading} error={leadsError} empty={!leadItems.length}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={
                      leadItems.length > 0 && leadItems.every((l) => selectedLeadIds.has(l.id))
                    }
                    onCheckedChange={toggleAllLeads}
                    aria-label={t("common.select")}
                  />
                </TableHead>
                <TableHead className="w-12">#</TableHead>
                <TableHead>{t("audit.createdAt")}</TableHead>
                <TableHead>{t("common.name")}</TableHead>
                <TableHead>{t("tenants.mobile")}</TableHead>
                <TableHead>{t("portal.messages.body")}</TableHead>
                <TableHead>{t("landing.admin.leads.status")}</TableHead>
                <TableHead>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leadItems.map((lead, index) => (
                <TableRow
                  key={lead.id}
                  id={`lead-${lead.id}`}
                  className={
                    lead.id === highlightId
                      ? "bg-primary/10"
                      : lead.status === "new"
                        ? "bg-accent/10"
                        : ""
                  }
                >
                  <TableCell>
                    <Checkbox
                      checked={selectedLeadIds.has(lead.id)}
                      onCheckedChange={() => toggleLeadId(lead.id)}
                      aria-label={t("common.select")}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">{index + 1}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {dateFormatter.format(new Date(lead.created_at))}
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-1">
                      <Building className="size-3 text-muted-foreground" />
                      {lead.name}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Mail className="size-3" />
                      <LtrText>{lead.email}</LtrText>
                    </div>
                  </TableCell>
                  <TableCell className="xs">
                    <div className="flex items-center gap-1">
                      <Phone className="size-3 text-muted-foreground" />
                      <LtrText>{lead.phone}</LtrText>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-md whitespace-pre-wrap text-sm">
                    {lead.message ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={lead.status}
                      onValueChange={(status) => updateLeadStatus(lead.id, status as LeadStatus)}
                      disabled={!canManage || updateLeadPending}
                    >
                      <SelectTrigger className="h-8 w-[130px] text-xs pointer-coarse:min-h-11">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LEAD_STATUSES.map((status) => (
                          <SelectItem key={status} value={status}>
                            {t(`landing.admin.leads.status.${status}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive pointer-coarse:size-11"
                      aria-label={t("common.delete")}
                      title={t("common.delete")}
                      onClick={() => setDeleteLeadIds([lead.id])}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableState>
        <Pager page={leadPage} pageSize={inboxPageSize} count={leadsCount} setPage={setLeadPage} />
      </CardContent>
    </Card>
  );
}
