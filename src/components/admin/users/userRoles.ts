import type { AppRole } from "@/integrations/supabase/database.types";

/** كل الأدوار التي يمكن منحها لحساب، بترتيب عرضها. */
export const APP_ROLES: AppRole[] = ["admin", "accountant", "collector", "readonly", "tenant"];
/** الأدوار الإدارية — كل الأدوار عدا المستأجر. */
export const MANAGERIAL_ROLES: Exclude<AppRole, "tenant">[] = [
  "admin",
  "accountant",
  "collector",
  "readonly",
];

/** الدور المطلوب سحبه من مستخدم، مع ما يلزم لعرض تحذير الروابط. */
export interface RevokeTarget {
  userId: string;
  role: AppRole;
  /** Linked tenant count at the moment the dialog opened, for the warning. */
  assignedCount: number;
  /** Whether `profiles.tenant_id` is set, for the warning. */
  hasPortalLink: boolean;
}
