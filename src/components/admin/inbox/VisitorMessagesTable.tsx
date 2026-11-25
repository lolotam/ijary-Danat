import { Building, Mail, MailOpen, Phone, Trash2 } from "lucide-react";

import { Pager, TableState } from "@/components/admin/Phase2Ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { LtrText } from "@/components/ui/ltr-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ContactInquiry } from "@/hooks/useTenantMessages";
import { useI18n } from "@/i18n/provider";

/**
 * جدول رسائل الزوار في صندوق الوارد.
 *
 * Extracted from admin.inbox.tsx, which was 1249 lines. Behaviour is unchanged.
 */
export function VisitorMessagesTable({
  selectedInquiryIds,
  setDeleteInquiryIds,
  inquiriesLoading,
  inquiriesError,
  inquiryItems,
  allInquirySelected,
  toggleAllInquiries,
  toggleInquiryId,
  highlightId,
  dateFormatter,
  markInquiryRead,
  markInquiryReadPending,
  inquiryPage,
  setInquiryPage,
  inboxPageSize,
  inquiriesCount,
}: {
  selectedInquiryIds: Set<string>;
  setDeleteInquiryIds: (ids: string[]) => void;
  inquiriesLoading: boolean;
  inquiriesError: boolean;
  inquiryItems: ContactInquiry[];
  allInquirySelected: boolean;
  toggleAllInquiries: () => void;
  toggleInquiryId: (id: string) => void;
  highlightId?: string;
  dateFormatter: Intl.DateTimeFormat;
  markInquiryRead: (id: string) => void;
  markInquiryReadPending: boolean;
  inquiryPage: number;
  setInquiryPage: (page: number) => void;
  inboxPageSize: number;
  inquiriesCount: number;
}) {
  const { t } = useI18n();

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{t("inbox.contactInquiries")}</CardTitle>
          <CardDescription>{t("inbox.subtitle")}</CardDescription>
        </div>
        {selectedInquiryIds.size > 0 ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setDeleteInquiryIds([...selectedInquiryIds])}
          >
            <Trash2 className="size-4" />
            {t("inbox.deleteSelected")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        <TableState loading={inquiriesLoading} error={inquiriesError} empty={!inquiryItems.length}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allInquirySelected}
                    onCheckedChange={toggleAllInquiries}
                    aria-label={t("common.select")}
                  />
                </TableHead>
                <TableHead className="w-12">#</TableHead>
                <TableHead>{t("audit.createdAt")}</TableHead>
                <TableHead>{t("common.name")}</TableHead>
                <TableHead>{t("tenants.mobile")}</TableHead>
                <TableHead>{t("portal.messages.subject")}</TableHead>
                <TableHead>{t("portal.messages.body")}</TableHead>
                <TableHead>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inquiryItems.map((inquiry, index) => (
                <TableRow
                  key={inquiry.id}
                  id={`visitor-${inquiry.id}`}
                  className={
                    inquiry.id === highlightId
                      ? "bg-primary/10"
                      : inquiry.status === "new"
                        ? "bg-accent/10"
                        : ""
                  }
                >
                  <TableCell>
                    <Checkbox
                      checked={selectedInquiryIds.has(inquiry.id)}
                      onCheckedChange={() => toggleInquiryId(inquiry.id)}
                      aria-label={t("common.select")}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">{index + 1}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {dateFormatter.format(new Date(inquiry.created_at))}
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-1">
                      <Building className="size-3 text-muted-foreground" />
                      {inquiry.name}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Mail className="size-3" />
                      <LtrText>{inquiry.email}</LtrText>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="flex items-center gap-1">
                      <Phone className="size-3 text-muted-foreground" />
                      <LtrText>{inquiry.phone ?? "—"}</LtrText>
                    </div>
                  </TableCell>
                  <TableCell>{inquiry.subject ?? "—"}</TableCell>
                  <TableCell className="max-w-md whitespace-pre-wrap text-sm">
                    {inquiry.message}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {inquiry.status === "new" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="pointer-coarse:min-h-11"
                          disabled={markInquiryReadPending}
                          onClick={() => markInquiryRead(inquiry.id)}
                        >
                          <MailOpen className="size-4" />
                          {t("inbox.markRead")}
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive pointer-coarse:size-11"
                        aria-label={t("common.delete")}
                        title={t("common.delete")}
                        onClick={() => setDeleteInquiryIds([inquiry.id])}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableState>
        <Pager
          page={inquiryPage}
          pageSize={inboxPageSize}
          count={inquiriesCount}
          setPage={setInquiryPage}
        />
      </CardContent>
    </Card>
  );
}
