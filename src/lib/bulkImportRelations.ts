export interface ResolvedLocation {
  propertyId: string;
  building: { id: string; property_id: string } | null;
  unit: { id: string; property_id: string; building_id: string | null } | null;
}

export function validateResolvedLocation(location: ResolvedLocation): string | null {
  if (location.building && location.building.property_id !== location.propertyId) {
    return "building_code does not belong to property_code";
  }
  if (location.unit && location.unit.property_id !== location.propertyId) {
    return "unit_code does not belong to property_code";
  }
  if (location.unit && location.building && location.unit.building_id !== location.building.id) {
    return "unit_code does not belong to building_code";
  }
  return null;
}
