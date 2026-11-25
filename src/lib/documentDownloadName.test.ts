import { describe, expect, it } from "vitest";

import { documentDownloadName } from "./documentDownloadName";

describe("documentDownloadName", () => {
  it("names the download after the display name with the stored extension", () => {
    // Regression, 2026-09-01: downloads saved as the UUID leaf because the
    // signed URL used a bare `download: true`.
    expect(
      documentDownloadName("عقد الإيجار", "companies/c1/tenants/t1/documents/1f2f9c33-ab.pdf"),
    ).toBe("عقد الإيجار.pdf");
  });

  it("does not double an extension the admin already typed", () => {
    expect(documentDownloadName("Lease.PDF", "docs/uuid.pdf")).toBe("Lease.PDF");
  });

  it("falls back when there is no display name", () => {
    expect(documentDownloadName(null, "docs/uuid.jpg", "deposit")).toBe("deposit.jpg");
  });

  it("returns the bare name when the stored path has no extension", () => {
    expect(documentDownloadName("مستند", "chat/965/wamid/file")).toBe("مستند");
  });

  it("strips path separators from an untrusted display name", () => {
    expect(documentDownloadName("../etc/passwd", "docs/uuid.pdf")).toBe(".._etc_passwd.pdf");
  });
});
