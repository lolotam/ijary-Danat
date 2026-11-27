/**
 * Translation keys for the company domains panel.
 */
export const platformDomains: Record<string, string> = {
  "platformDomains.title": "Company domains",
  "platformDomains.empty": "No domain is registered yet.",
  "platformDomains.added": "The domain was added and is waiting for the ownership check.",
  "platformDomains.verified": "The domain is verified and serving now.",
  "platformDomains.verifyFailed": "The domain is not verified yet.",
  "platformDomains.kind.custom": "Custom domain",
  "platformDomains.kind.subdomain": "Automatic address",
  "platformDomains.status.verified": "Verified",
  "platformDomains.status.pending": "Awaiting verification",
  "platformDomains.status.failed": "Verification failed",
  "platformDomains.verify": "Check the status",
  "platformDomains.hostLabel": "Custom domain",
  "platformDomains.hostPlaceholder": "www.example.com",
  "platformDomains.add": "Add a domain",
  "platformDomains.error.invalid": "Write a valid domain name, such as www.example.com.",
  "platformDomains.error.reserved": "This domain is reserved for the platform, or sits under it.",
  "platformDomains.error.taken": "This domain is already used by another company.",
  "platformDomains.error.notFound": "No domain carries this id.",
  "platformDomains.error.notCloudflare":
    "This domain is not linked to Cloudflare, so it cannot be verified.",
};
