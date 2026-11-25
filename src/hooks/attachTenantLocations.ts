import type { ContractState, Tables } from "@/integrations/supabase/database.types";
import { fetchTenantListRelations } from "@/hooks/listRelations";
import type { BrandAssetUrls } from "@/lib/brandLogos";
import {
  dedupeById,
  resolveContractLocation,
  selectActiveContractsByTenant,
} from "@/lib/tenantLocations";

type Tenant = Tables<"tenants">;

/** One active contract with every unit and building it puts the tenant in. */
export interface TenantActiveLocation {
  contract: {
    id: string;
    code: string;
    state: ContractState;
    start_date: string;
    end_date: string | null;
    /** Trigger-maintained total of the contract's unit rents (migration 110). */
    monthly_amount: number;
  };
  /**
   * The first unit by `line_order`. Kept alongside `units` because the tenants
   * list sorts and exports on a single value, and a sort key that is an array
   * has no meaning.
   */
  unit: Tables<"units"> | null;
  property: Tables<"properties"> | null;
  /** Every unit on the contract, in `line_order`. */
  units: Tables<"units">[];
  /** The distinct buildings those units are in. */
  properties: Tables<"properties">[];
  /** Store Logo for this contract's shop — never borrowed from a sibling contract. */
  logoUrl: string | null;
  /** Shop Card Image for this contract's shop. */
  cardUrl: string | null;
}

/**
 * One contract in any state, with whether it is currently in arrears.
 *
 * Separate from `TenantActiveLocation` because the two answer different
 * questions and are deliberately scoped differently: the location list is
 * active-only, since it says where the tenant is *now*, while the lifecycle
 * column summarises everything they hold — an expired contract still carrying
 * unpaid invoices is exactly what that column exists to surface.
 */
export interface TenantContractStatus {
  id: string;
  code: string;
  state: ContractState;
  hasOverdue: boolean;
}

export interface TenantWithActiveLocation extends Tenant {
  /**
   * The primary active contract's building — the newest one. Singular because
   * the tenants list sorts on it and exports it to CSV, neither of which has a
   * meaning over an array. Every building the tenant is in is
   * `connectedProperties`; every contract is `activeContracts`.
   */
  connectedProperty: Tables<"properties"> | null;
  connectingUnit: Tables<"units"> | null;
  hasOverdue: boolean;
  /** Start date of the tenant's primary active contract, or null if none. */
  activeContractStartDate: string | null;
  /** End date of the tenant's primary active contract, or null if none. */
  activeContractEndDate: string | null;
  /** Every active contract, newest start first. The primary is [0]. */
  activeContracts: TenantActiveLocation[];
  /** Distinct buildings across those contracts — the same building once. */
  connectedProperties: Tables<"properties">[];
  /** Every contract in any state, for the lifecycle column's status counts. */
  contractStatuses: TenantContractStatus[];
  /** Store Logo — brands carousel (list/table view). */
  shopLogoUrl: string | null;
  /** Shop Card Image — store directory / Explore Our Shops (card view 1:1). */
  shopCardUrl: string | null;
}

/** Shape `selectActiveContractsByTenant` feeds into the location builder. */
interface LocationContractInput {
  id: string;
  code: string;
  state: ContractState;
  start_date: string;
  end_date: string | null;
  monthly_amount: number;
  unit_ids: string[];
}

/**
 * يبني مواقع العقود النشطة ويلصق شعار كل عقد على موقعه هو، لا على العقد الأول فقط.
 *
 * The list used to stamp `brands.get(primary.id)` onto the tenant and never
 * onto the location. A second shop then inherited the first logo — or had none.
 */
export function buildTenantActiveLocations(
  contracts: LocationContractInput[],
  unitById: Map<string, Tables<"units">>,
  propertyById: Map<string, Tables<"properties">>,
  brands: Map<string, BrandAssetUrls>,
): TenantActiveLocation[] {
  return contracts.map((contract) => {
    const { units: contractUnits, properties: contractProperties } = resolveContractLocation(
      contract.unit_ids,
      unitById,
      propertyById,
    );
    const brand = brands.get(contract.id);
    return {
      contract: {
        id: contract.id,
        code: contract.code,
        state: contract.state,
        start_date: contract.start_date,
        end_date: contract.end_date,
        monthly_amount: contract.monthly_amount,
      },
      unit: contractUnits[0] ?? null,
      property: contractProperties[0] ?? null,
      units: contractUnits,
      properties: contractProperties,
      logoUrl: brand?.logoUrl ?? null,
      cardUrl: brand?.cardUrl ?? null,
    };
  });
}

/**
 * يُبقي شعار المستأجر على مستوى الصف هو شعار العقد الأساسي فقط.
 *
 * CSV export and the mobile card list still read a single pair of URLs. Those
 * callers must not start iterating locations, so the primary remains the
 * convenience field — not the source of truth.
 */
export function primaryShopBrandUrls(locations: TenantActiveLocation[]): {
  shopLogoUrl: string | null;
  shopCardUrl: string | null;
} {
  const primary = locations[0];
  return {
    shopLogoUrl: primary?.logoUrl ?? null,
    shopCardUrl: primary?.cardUrl ?? null,
  };
}

/**
 * يلصق العقود النشطة والعلامات المتأخرة على صفوف المستأجرين بعد جلبها.
 *
 * Kept out of `useTenants` so the hook file stays one job (CRUD + queries) and
 * under the 600-line ceiling. Brand URLs are keyed by contract id here — the
 * tenant-level pair is only the primary contract's convenience copy.
 */
export async function attachActiveLocations(
  tenants: Tenant[],
): Promise<TenantWithActiveLocation[]> {
  const bare = tenants.map((tenant) => ({
    ...tenant,
    connectedProperty: null,
    connectingUnit: null,
    hasOverdue: false,
    activeContractStartDate: null as string | null,
    activeContractEndDate: null as string | null,
    activeContracts: [] as TenantActiveLocation[],
    connectedProperties: [] as Tables<"properties">[],
    contractStatuses: [] as TenantContractStatus[],
    shopLogoUrl: null as string | null,
    shopCardUrl: null as string | null,
  }));
  if (!tenants.length) return bare;
  // One request (`tenant_list_relations`, migration 244) instead of the four
  // that used to run one after another. It returns every contract in any
  // state, not only `active`: the lifecycle column counts what a tenant holds
  // across all of their contracts, so an expired or terminated one has to
  // arrive here to be counted. `selectActiveContractsByTenant` below still
  // narrows to active for the property, unit and contract columns, which
  // answer "where is this tenant now" and must not gain buildings they left.
  const relations = await fetchTenantListRelations(tenants.map((tenant) => tenant.id));
  // Units live on contract_units now (migration 110), not contracts.unit_id.
  // The RPC returns the lines in line_order within each contract, which the
  // grouping below preserves.
  const unitIdsByContract = new Map<string, string[]>();
  for (const row of relations.contractUnits) {
    const forContract = unitIdsByContract.get(row.contract_id);
    if (forContract) forContract.push(row.unit_id);
    else unitIdsByContract.set(row.contract_id, [row.unit_id]);
  }
  const contracts = relations.contracts.map((contract) => ({
    ...contract,
    unit_ids: unitIdsByContract.get(contract.id) ?? [],
  }));
  // Every active contract, not only the newest: a tenant can rent a second shop
  // and the list has to show both. The primary (index 0) still drives the
  // sortable and exported columns.
  const contractsByTenant = selectActiveContractsByTenant(contracts);
  const { units, properties, overdue: overdueRows, brandByContract } = relations;
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const overdueTenants = new Set(overdueRows.map((row) => row.tenant_id));
  const overdueContracts = new Set(overdueRows.map((row) => row.contract_id));
  const statusesByTenant = contracts.reduce((byTenant, contract) => {
    const forTenant = byTenant.get(contract.tenant_id) ?? [];
    forTenant.push({
      id: contract.id,
      code: contract.code,
      state: contract.state,
      hasOverdue: overdueContracts.has(contract.id),
    });
    byTenant.set(contract.tenant_id, forTenant);
    return byTenant;
  }, new Map<string, TenantContractStatus[]>());
  return tenants.map((tenant) => {
    const locations = buildTenantActiveLocations(
      contractsByTenant.get(tenant.id) ?? [],
      unitById,
      propertyById,
      brandByContract,
    );
    const primary = locations[0];
    return {
      ...tenant,
      connectingUnit: primary?.unit ?? null,
      connectedProperty: primary?.property ?? null,
      hasOverdue: overdueTenants.has(tenant.id),
      activeContractStartDate: primary?.contract.start_date ?? null,
      activeContractEndDate: primary?.contract.end_date ?? null,
      activeContracts: locations,
      // Across every unit of every active contract, not just each contract's
      // first: a contract whose units sit in two buildings puts the tenant in
      // both, and this column answers which buildings they are in.
      connectedProperties: dedupeById(locations.flatMap((location) => location.properties)),
      contractStatuses: statusesByTenant.get(tenant.id) ?? [],
      ...primaryShopBrandUrls(locations),
    };
  });
}
