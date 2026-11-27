import type { JobKind } from "@/jobs/catalog";
import type { JobHandler } from "@/worker/runJob";

import { createCompanyInfoSendHandler } from "./documentsCompanyInfo";
import { createInvoiceSendHandler } from "./documentsInvoice";
import { createPaymentReceiptHandler } from "./documentsPayment";
import { createReportRunHandler } from "./documentsReport";

/**
 * نتيجة حجز مهمة مستند: العمل غادر الطلب ولم يُنفَّذ بعد.
 *
 * `jobRequestIds` are the `job_requests` rows the worker will pick up. The
 * caller shows them as "queued", never as "sent": the document is still to be
 * rendered and the message still to be delivered, so a toast that says "sent"
 * here would be a lie the moment the provider is slow.
 */
export interface QueuedDocumentJob {
  queued: true;
  jobRequestIds: string[];
}

/**
 * يبني معالجات أنواع المهام التي تنتج مستندات: فاتورة، إيصال دفعة، معلومات شركة، تقرير.
 *
 * These kinds run on the `docs` queue and end on the notify queue: the handler
 * renders the document and writes the notification rows, and the notify worker
 * delivers them (contracts/jobs.md section 4). No handler sends through a
 * provider directly, so none of them needs the WhatsApp pacing lock — that
 * lock belongs to the notify worker, which is where the send happens.
 *
 * `contract.pdf` and `report.export` have no handler yet: the contract PDF is
 * produced by `renderContractPdf` as a direct download for the browser, and
 * the reports screen exports CSV in the browser. Neither has a server function
 * whose slow work could move into a job, and inventing one would be a second
 * implementation of work that already exists elsewhere.
 */
export function createDocumentHandlers(): Partial<Record<JobKind, JobHandler>> {
  return {
    "company.info.send": createCompanyInfoSendHandler(),
    "invoice.send": createInvoiceSendHandler(),
    "payment.receipt": createPaymentReceiptHandler(),
    "report.run": createReportRunHandler(),
  };
}
