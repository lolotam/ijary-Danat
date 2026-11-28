import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { companyLogoObjectPath, contractLogoDataUri } from "./logo.server";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const publicUrl = (path: string) =>
  `https://api.ijary.app/storage/v1/object/public/branding/${path}`;

describe("companyLogoObjectPath", () => {
  test("accepts an object in the company's own branding folder", () => {
    expect(companyLogoObjectPath(publicUrl(`companies/${COMPANY}/logo/1.png`), COMPANY)).toBe(
      `companies/${COMPANY}/logo/1.png`,
    );
  });

  test.each([
    ["another company's folder", publicUrl(`companies/${OTHER}/logo/1.png`)],
    ["a traversal out of the folder", publicUrl(`companies/${COMPANY}/..%2F${OTHER}/logo.png`)],
    [
      "another bucket",
      `https://api.ijary.app/storage/v1/object/public/landing/companies/${COMPANY}/a.png`,
    ],
    ["an arbitrary host path", "http://169.254.169.254/latest/meta-data"],
    ["a non-URL", "logo.png"],
  ])("rejects %s", (_label, url) => {
    expect(companyLogoObjectPath(url, COMPANY)).toBeNull();
  });
});

describe("contractLogoDataUri", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SUPABASE_URL", "http://kong:8000/");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test("fetches from the server's own storage origin and inlines the image", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    const uri = await contractLogoDataUri(publicUrl(`companies/${COMPANY}/logo/1.png`), COMPANY);
    expect(uri).toBe("data:image/png;base64,AQID");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `http://kong:8000/storage/v1/object/public/branding/companies/${COMPANY}/logo/1.png`,
    );
  });

  test("never fetches a logo outside the company's folder", async () => {
    expect(await contractLogoDataUri("http://169.254.169.254/x.png", COMPANY)).toBeNull();
    expect(await contractLogoDataUri(null, COMPANY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ["a failed response", () => new Response("no", { status: 404 })],
    ["a non-image", () => new Response("<html>", { headers: { "content-type": "text/html" } })],
  ])("prints no logo on %s", async (_label, respond) => {
    fetchMock.mockResolvedValue(respond());
    expect(
      await contractLogoDataUri(publicUrl(`companies/${COMPANY}/logo/1.png`), COMPANY),
    ).toBeNull();
  });

  test("prints no logo when the fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    expect(
      await contractLogoDataUri(publicUrl(`companies/${COMPANY}/logo/1.png`), COMPANY),
    ).toBeNull();
  });
});
