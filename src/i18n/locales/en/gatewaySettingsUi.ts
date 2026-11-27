/**
 * Translation of the payment-gateway settings screen and the renter's note (English).
 *
 * Secret values are never translated or displayed; these keys label the fields
 * around them only.
 */
export const gatewaySettingsUi: Record<string, string> = {
  "gatewaySettingsUi.title": "Payment gateways",
  "gatewaySettingsUi.description":
    "Enter your account details for each provider, test the connection, then activate one gateway to collect online payments.",

  "gatewaySettingsUi.provider.myfatoorah": "MyFatoorah",
  "gatewaySettingsUi.provider.tap": "Tap",
  "gatewaySettingsUi.provider.upayments": "UPayments",

  "gatewaySettingsUi.badge.notSet": "Not configured",
  "gatewaySettingsUi.badge.test": "Test · active",
  "gatewaySettingsUi.badge.live": "Live · active",
  "gatewaySettingsUi.badge.inactive": "Inactive",

  "gatewaySettingsUi.credential.apiKey": "API key",
  "gatewaySettingsUi.credential.webhookSecret": "Webhook secret",
  "gatewaySettingsUi.credential.stored": "Stored: last 4 characters",
  "gatewaySettingsUi.credential.hint": "Leave blank to keep the stored value.",
  "gatewaySettingsUi.enterCredential": "Enter at least one credential before saving.",

  "gatewaySettingsUi.testMode": "Test mode",
  "gatewaySettingsUi.mode.test": "Test",
  "gatewaySettingsUi.mode.live": "Live",

  "gatewaySettingsUi.save": "Save credentials",
  "gatewaySettingsUi.saving": "Saving…",
  "gatewaySettingsUi.saved": "Credentials saved.",
  "gatewaySettingsUi.saveError": "The credentials could not be saved.",

  "gatewaySettingsUi.testConnection": "Test connection",
  "gatewaySettingsUi.testing": "Testing…",
  "gatewaySettingsUi.testOk": "The connection works.",
  "gatewaySettingsUi.testFailed": "The connection test failed.",

  "gatewaySettingsUi.activate": "Activate",
  "gatewaySettingsUi.deactivate": "Deactivate",
  "gatewaySettingsUi.confirmActivateTitle": "Activate the gateway",
  "gatewaySettingsUi.confirmActivateBody":
    "This provider becomes the company's active payment gateway; any other provider is deactivated.",
  "gatewaySettingsUi.confirmDeactivateTitle": "Deactivate the gateway",
  "gatewaySettingsUi.confirmDeactivateBody":
    "Online payment will no longer be offered to renters after deactivation.",
  "gatewaySettingsUi.confirm": "Confirm",
  "gatewaySettingsUi.cancel": "Cancel",
  "gatewaySettingsUi.activated": "The gateway is active.",
  "gatewaySettingsUi.deactivated": "The gateway is inactive.",
  "gatewaySettingsUi.actionError": "The action could not be completed.",

  "gatewaySettingsUi.oneActive": "Only one gateway can be active per company.",
  "gatewaySettingsUi.lastTestAt": "Last test",
  "gatewaySettingsUi.lastTestResult": "Test result",
  "gatewaySettingsUi.never": "Not tested yet",

  "gatewaySettingsUi.webhookLabel": "Webhook URL",
  "gatewaySettingsUi.copy": "Copy",
  "gatewaySettingsUi.copied": "The URL was copied.",
  "gatewaySettingsUi.copyFailed": "The URL could not be copied.",

  "gatewaySettingsUi.portal.payAtOffice":
    "Online payment is not available. Please pay at the company's office.",
};
