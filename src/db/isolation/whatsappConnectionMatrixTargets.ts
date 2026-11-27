import { randomUUID } from "node:crypto";

import {
  buildScopedInsert,
  makeTarget,
  type ColumnSetMap,
  type CompanyTableTarget,
} from "@/db/isolation/seedGraphHelpers";

/**
 * يبني أهداف مصفوفة العزل لجدولي اتصال واتساب: القديم `evolution_connections` والجديد `whatsapp_connections` (ترحيل 333).
 *
 * Both tables stay until the Evolution code moves to `whatsapp_connections`
 * (T159–T162), so the matrix checks that neither company can read or change the
 * other's connection in either table.
 */
export function buildWhatsappConnectionMatrixTargets(
  cid: string,
  colMap: ColumnSetMap,
): CompanyTableTarget[] {
  const targets: CompanyTableTarget[] = [];

  if (colMap.has("evolution_connections")) {
    targets.push({
      table: "evolution_connections",
      whereSql: "id = 1",
      whereParams: [],
      updateSetSql: "instance_name = 'mutated'",
      updateParams: [],
      buildCrossCompanyInsert: (foreignCid, cm) =>
        buildScopedInsert(cm, "evolution_connections", foreignCid, {
          id: 1,
          company_id: foreignCid,
          instance_name: `inst-x-${randomUUID().slice(0, 6)}`,
          webhook_secret: "sec-x",
        }),
    });
  }

  if (colMap.has("whatsapp_connections")) {
    targets.push(
      makeTarget("whatsapp_connections", "company_id", cid, "last_error", "mutated", () => ({
        values: { method: "cloud_api", is_active: false, status: "disconnected" },
      })),
    );
  }

  return targets;
}
