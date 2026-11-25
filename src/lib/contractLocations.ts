interface LocatedUnit {
  building_id: string | null;
  property_id: string;
}

export function filterUnitsByLocation<T extends LocatedUnit>(
  units: T[],
  propertyId: string,
  buildingId: string | null,
): T[] {
  return units.filter(
    (unit) => unit.property_id === propertyId && (!buildingId || unit.building_id === buildingId),
  );
}
