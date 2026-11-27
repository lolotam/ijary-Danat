/**
 * English translation keys for platform payment gateway live-mode launch controls (SC-012).
 */
export const gatewayLaunch: Record<string, string> = {
  "platform.nav.gateways": "Payment gateways",
  "platformGateways.title": "Payment gateway launch",
  "platformGateways.subtitle":
    "Allow companies to use live mode per provider after completing the SC-012 checklist.",
  "platformGateways.panelTitle": "Provider live-mode availability",
  "platformGateways.panelDescription":
    "Test mode is always allowed. Turning live mode off does not change existing live connections.",
  "platformGateways.provider.myfatoorah": "MyFatoorah",
  "platformGateways.provider.tap": "Tap",
  "platformGateways.provider.upayments": "UPayments",
  "platformGateways.status.allowed": "Live allowed",
  "platformGateways.status.blocked": "Test only",
  "platformGateways.switchAria": "Toggle live mode allowance",
  "platformGateways.confirmTitleEnable": "Confirm enabling live mode",
  "platformGateways.confirmTitleDisable": "Confirm disabling live mode",
  "platformGateways.confirmBodyEnable":
    "SC-012 requires all cases to be recorded in sandbox first (success, failure, cancellation, expiry, and duplicate) across confirmation webhook, return page, and reconciliation before enabling live mode.",
  "platformGateways.confirmBodyDisable":
    "Companies will not be able to switch a new connection to live mode for this provider (SC-012). The {count} companies already live on it keep working as they are; their collection does not stop.",
  "platformGateways.liveConnections": "Companies currently live: {count}",
  "platformGateways.confirmAction": "Confirm",
  "platformGateways.saved": "Provider launch setting updated.",
  "platformGateways.loadError": "Could not load payment gateway launch settings.",
  "platformGateways.saveError": "Could not update payment gateway launch setting.",
};
