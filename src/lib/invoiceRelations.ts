/**
 * تحميل الفواتير مع علاقاتها (المستأجر، العقد، الوحدات، العقارات) بأي عميل Supabase.
 *
 * Lifted out of `useInvoices.ts` so the SERVER can load the same rows the
 * browser does. The emailed payment receipt used to render a document of its
 * own because the invoice paper needs these relations and the only loader for
 * them was bound to the browser client — so the mail carried a different
 * document from the one every screen prints. The client is a parameter now;
 * `supabase` and `supabaseAdmin` both satisfy it, and there is one enrichment
 * to keep correct rather than two.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/integrations/supabase/database.types";
import { fetchInChunks } from "@/lib/idChunks";
import {
  EXTRA_CHARGE_ITEM_COLUMNS,
  resolveExtraChargesByInvoice,
  type ExtraChargeItemRow,
  type ExtraChargeLine,
} from "@/lib/invoiceExtraCharges";

export type Invoice = Tables<"invoices">;

/**
 * ما تحتاجه هذه الوحدة من عميل Supabase، لا العميل كاملاً.
 *
 * Structural rather than the concrete client: it is what lets the browser
 * client and the service-role client reach the same function without either
 * module importing the other's.
 */
export type InvoiceRelationsClient = Pick<SupabaseClient<Database>, "from">;

export interface InvoiceWithRelations extends Invoice {
  contract: Tables<"contracts"> | null;
  tenant: Tables<"tenants"> | null;
  /**
   * Every unit the invoice bills for, ordered by code. A multi-unit contract
   * produces one consolidated invoice per month covering all of them
   * (migration 112), so this is the field display sites should render.
   */
  units: Tables<"units">[];
  /** The distinct properties those units belong to. */
  properties: Tables<"properties">[];
  /** The single unit, or null when the invoice covers several. Prefer `units`. */
  unit: Tables<"units"> | null;
  /** The single property, or null when the units span several. Prefer `properties`. */
  property: Tables<"properties"> | null;
  /**
   * The invoice's recurring service-charge lines, empty when it bills rent
   * alone. Read from the invoice's own items, so a charge added to the contract
   * later never changes what an already-issued invoice says it charged.
   */
  extraCharges: ExtraChargeLine[];
}

/**
 * يلفّ صف فاتورة بعلاقات فارغة، للمسارات التي فشل فيها جلب العلاقات.
 *
 * The "no relations" shape lives beside the interface rather than at the call
 * site so the two cannot disagree: a field added to {@link InvoiceWithRelations}
 * is a compile error here and nowhere else, which is the only reason a caller's
 * hand-written fallback would not quietly keep printing a stale shape.
 */
export function withoutRelations(invoice: Invoice): InvoiceWithRelations {
  return {
    ...invoice,
    contract: null,
    tenant: null,
    units: [],
    properties: [],
    unit: null,
    property: null,
    extraCharges: [],
  };
}

/**
 * يجمع معرّفات الوحدات لكل فاتورة من بنود الفاتورة، لا من عمود الفاتورة نفسه.
 *
 * `invoices.unit_id` is NULL for a consolidated multi-unit invoice (migration
 * 112), so reading it alone showed an empty Unit cell on every invoice of a
 * multi-unit contract. `invoice_items` carries one rent line per unit, each
 * with its own `unit_id`, which covers single-unit and consolidated invoices
 * alike.
 *
 * The `invoices.unit_id` fallback is for rows whose line items carry no
 * attribution at all — migration 112 backfilled rent lines, but a hand-inserted
 * or concession-only invoice need not have one.
 */
export function resolveUnitIdsByInvoice(
  invoices: ReadonlyArray<{ id: string; unit_id: string | null }>,
  items: ReadonlyArray<{ invoice_id: string; unit_id: string | null }>,
): Map<string, string[]> {
  const byInvoice = new Map<string, string[]>();
  for (const row of items) {
    if (!row.unit_id) continue;
    const current = byInvoice.get(row.invoice_id) ?? [];
    // A concession line can repeat a unit already carried by its rent line.
    if (!current.includes(row.unit_id)) current.push(row.unit_id);
    byInvoice.set(row.invoice_id, current);
  }
  for (const invoice of invoices) {
    if (!byInvoice.has(invoice.id) && invoice.unit_id) {
      byInvoice.set(invoice.id, [invoice.unit_id]);
    }
  }
  return byInvoice;
}

/** صف بند فاتورة بالأعمدة التي تحتاجها شاشات العرض: الوحدة والمصروف الدوري. */
type InvoiceItemForDisplay = ExtraChargeItemRow & { unit_id: string | null };

/**
 * يقرأ بنود كل فاتورة على دفعات لا تتجاوز طول الرابط المسموح.
 *
 * Kong rejects the request line past 8 KB and a UUID costs ~37 bytes in an
 * `in()` filter, so the 238 invoices of a twenty-year lease asked for in one go
 * come back 414 - measured against production, not assumed. `fetchInChunks`
 * holds that ceiling.
 *
 * Unit attribution and the service-charge breakdown both come from these rows,
 * so the select is widened rather than a second query added: the two need the
 * same lines of the same table for the same invoices, and a second round trip
 * would double the chunking cost to answer half the question.
 */
async function invoiceItemsForDisplay(
  client: InvoiceRelationsClient,
  invoices: Invoice[],
): Promise<InvoiceItemForDisplay[]> {
  return fetchInChunks(
    invoices.map((invoice) => invoice.id),
    (chunk) =>
      client
        .from("invoice_items")
        .select(`${EXTRA_CHARGE_ITEM_COLUMNS}, unit_id`)
        .in("invoice_id", chunk),
  );
}

/**
 * يجلب الفواتير مع علاقاتها (المستأجر، الوحدات، العقارات) لصفوف محمّلة مسبقًا.
 *
 * Callers already hold raw invoice rows — the portal through a payment's
 * allocations, the notification path through the same — and this enriches them
 * with the relations the shared invoice document renders. Under the browser
 * client RLS scopes every query to the signed-in user; under the service-role
 * client the caller has already decided which invoices may be printed.
 */
export async function loadInvoicesWithRelations(
  client: InvoiceRelationsClient,
  invoices: Invoice[],
): Promise<InvoiceWithRelations[]> {
  if (!invoices.length) return [];
  const tenantIds = [...new Set(invoices.map((invoice) => invoice.tenant_id))];
  const contractIds = [...new Set(invoices.map((invoice) => invoice.contract_id))];
  const items = await invoiceItemsForDisplay(client, invoices);
  const unitIdsFor = resolveUnitIdsByInvoice(invoices, items);
  const extraChargesFor = resolveExtraChargesByInvoice(items);
  const unitIds = [...new Set([...unitIdsFor.values()].flat())];
  // Every one of these goes through `fetchInChunks`: the id lists grow with the
  // invoice list, and past ~200 ids the URL exceeds what the gateway accepts.
  const [tenantRows, unitRows, contractRows] = await Promise.all([
    fetchInChunks(tenantIds, (chunk) => client.from("tenants").select("*").in("id", chunk)),
    fetchInChunks(unitIds, (chunk) => client.from("units").select("*").in("id", chunk)),
    // archived_at is required for the "Archived contract" chip on invoice rows.
    fetchInChunks(contractIds, (chunk) =>
      client.from("contracts").select("*, archived_at").in("id", chunk),
    ),
  ]);
  const propertyIds = [...new Set(unitRows.map((unit) => unit.property_id))];
  const propertyRows = await fetchInChunks(propertyIds, (chunk) =>
    client.from("properties").select("*").in("id", chunk),
  );
  const tenants = new Map(tenantRows.map((tenant) => [tenant.id, tenant]));
  const unitsById = new Map(unitRows.map((unit) => [unit.id, unit]));
  const contracts = new Map(contractRows.map((contract) => [contract.id, contract]));
  const propertiesById = new Map(propertyRows.map((property) => [property.id, property]));
  return invoices.map((invoice) => {
    const units = (unitIdsFor.get(invoice.id) ?? [])
      .map((unitId) => unitsById.get(unitId))
      .filter((unit): unit is Tables<"units"> => unit != null)
      .sort((left, right) => left.code.localeCompare(right.code));
    const properties = [
      ...new Map(
        units
          .map((unit) => propertiesById.get(unit.property_id))
          .filter((property): property is Tables<"properties"> => property != null)
          .map((property) => [property.id, property] as const),
      ).values(),
    ];
    return {
      ...invoice,
      contract: contracts.get(invoice.contract_id) ?? null,
      tenant: tenants.get(invoice.tenant_id) ?? null,
      units,
      properties,
      // Singular stays null unless the invoice really covers ONE of them, so a
      // caller that can only show one never silently shows the first of three.
      unit: units.length === 1 ? units[0] : null,
      property: properties.length === 1 ? properties[0] : null,
      extraCharges: extraChargesFor.get(invoice.id) ?? [],
    };
  });
}
