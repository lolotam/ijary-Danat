import { describe, expect, test } from "vitest";

import { NOTIFICATION_TYPES } from "@/integrations/supabase/database.types";

describe("NOTIFICATION_TYPES", () => {
  // Exact set, not a length check: swapping one valid member for another
  // preserves the length and would slip through.
  test("is exactly the twenty-one product types", () => {
    expect([...NOTIFICATION_TYPES].sort()).toEqual(
      [
        "company_info",
        "contact_inquiry",
        "contract_closeout",
        "contract_created",
        "contract_ended",
        "contract_expiry",
        "contract_restored",
        "deposit_confirmation",
        "document_send",
        "due_reminder",
        "invoice_disputed",
        "invoice_written_off",
        "maintenance_request",
        "manual_message",
        "overdue_reminder",
        "payment_admin_alert",
        "receipt",
        "refund_recorded",
        "scheduled_report",
        "user_credentials",
        "whatsapp_session_alert",
      ].sort(),
    );
  });
});
