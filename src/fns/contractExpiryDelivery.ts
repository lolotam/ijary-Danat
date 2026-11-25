export interface ContractExpiryDelivery {
  audience: "admin" | "tenant";
  channel: "email" | "whatsapp";
  contractId: string;
  milestone: string;
  recipientAddress: string;
}

export function contractExpiryDeliveryKey(delivery: ContractExpiryDelivery): string {
  return [
    delivery.contractId,
    delivery.milestone,
    delivery.audience,
    delivery.channel,
    delivery.recipientAddress.trim().toLowerCase(),
  ].join("|");
}

export function isContractExpiryDeliveryComplete(
  completedDeliveries: ReadonlySet<string>,
  delivery: ContractExpiryDelivery,
): boolean {
  return completedDeliveries.has(contractExpiryDeliveryKey(delivery));
}
