import { describe, expect, it } from "vitest";

import {
  assertPdfOrImageWithinStorageLimit,
  STORAGE_UPLOAD_CONNECTION_FAILED,
  STORAGE_UPLOAD_MAX_BYTES,
  STORAGE_UPLOAD_TIMED_OUT,
  storageUploadFailureCode,
} from "./uploadLimits";

/**
 * يبني ملفًا بحجم مزيف دون تخصيص المخزن.
 */
function fakeFile(options: { name: string; type: string; size: number }): File {
  const file = new File(["x"], options.name, { type: options.type });
  Object.defineProperty(file, "size", { value: options.size });
  return file;
}

describe("assertPdfOrImageWithinStorageLimit", () => {
  it("accepts an image that the old 10 MB client cap rejected", () => {
    expect(() =>
      assertPdfOrImageWithinStorageLimit(
        fakeFile({ name: "scan.jpg", type: "image/jpeg", size: 10 * 1024 * 1024 + 1 }),
      ),
    ).not.toThrow();
  });

  it("rejects a file over the storage-api 50 MiB ceiling", () => {
    expect(() =>
      assertPdfOrImageWithinStorageLimit(
        fakeFile({
          name: "scan.jpg",
          type: "image/jpeg",
          size: STORAGE_UPLOAD_MAX_BYTES + 1,
        }),
      ),
    ).toThrow(/50 MB/);
  });
});

describe("storageUploadFailureCode", () => {
  it("maps a timeout to the timed-out sentinel", () => {
    expect(storageUploadFailureCode(new Error("Upload timed out after 180000ms"))).toBe(
      STORAGE_UPLOAD_TIMED_OUT,
    );
  });

  it("maps the empty HTTP 400 Kong returned on the stalled PDF", () => {
    // Production 2026-08-23: POST tenant-documents returned 400 with 0-byte body
    // after ~60s; storage-api never logged the request.
    expect(storageUploadFailureCode({ message: "", statusCode: 400 })).toBe(
      STORAGE_UPLOAD_CONNECTION_FAILED,
    );
  });
});
