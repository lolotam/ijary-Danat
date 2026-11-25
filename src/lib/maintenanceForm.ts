import { z } from "zod";

import type { MaintenanceRequest } from "@/hooks/useMaintenance";
import type {
  MaintenancePriority,
  MaintenanceStatus,
} from "@/integrations/supabase/database.types";

/** أولويات طلب الصيانة بترتيب عرضها. */
export const MAINTENANCE_PRIORITIES: MaintenancePriority[] = ["low", "medium", "high", "urgent"];
/** حالات طلب الصيانة بترتيب عرضها. */
export const MAINTENANCE_STATUSES: MaintenanceStatus[] = [
  "open",
  "in_progress",
  "completed",
  "cancelled",
];

/**
 * مخطط نموذج طلب الصيانة.
 *
 * Building and unit are optional, but Radix Select forbids an empty value, so
 * "none" stands for "not set" inside the form and becomes null on save.
 */
export const maintenanceSchema = z.object({
  property_id: z.string().min(1),
  building_id: z.string(),
  unit_id: z.string(),
  title: z.string().trim().min(1),
  description: z.string(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  status: z.enum(["open", "in_progress", "completed", "cancelled"]),
});

/** قيم نموذج طلب الصيانة كما يحرّرها المستخدم. */
export type MaintenanceFormValues = z.infer<typeof maintenanceSchema>;

/** نموذج فارغ لطلب جديد: أولوية متوسطة، مفتوح، بلا مبنى ولا وحدة. */
export const maintenanceDefaults: MaintenanceFormValues = {
  property_id: "",
  building_id: "none",
  unit_id: "none",
  title: "",
  description: "",
  priority: "medium",
  status: "open",
};

/** يحوّل طلباً محفوظاً إلى قيم النموذج — المبنى والوحدة الفارغان يصبحان "none". */
export function maintenanceToForm(request: MaintenanceRequest): MaintenanceFormValues {
  return {
    property_id: request.property_id,
    building_id: request.building_id ?? "none",
    unit_id: request.unit_id ?? "none",
    title: request.title,
    description: request.description ?? "",
    priority: request.priority,
    status: request.status,
  };
}

/** يبني حمولة الحفظ: "none" يصبح null، والوصف الفارغ بعد التشذيب يصبح null. */
export function maintenancePayload(values: MaintenanceFormValues) {
  return {
    ...values,
    building_id: values.building_id === "none" ? null : values.building_id,
    unit_id: values.unit_id === "none" ? null : values.unit_id,
    description: values.description.trim() || null,
  };
}
