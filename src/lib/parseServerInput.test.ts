import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseServerInput } from "./parseServerInput";

const schema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9._-]+$/, "Username must be alphanumeric"),
  password: z.string().min(8).optional(),
});

describe("parseServerInput", () => {
  it("returns the parsed value on success", () => {
    expect(parseServerInput(schema, { username: "abu.ali" })).toEqual({ username: "abu.ali" });
  });

  it("throws a plain Error naming each failed field, never a ZodError", () => {
    let caught: unknown;
    try {
      parseServerInput(schema, { username: "أبو علي", password: "1234" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).constructor).toBe(Error);
    expect((caught as Error).message).toBe(
      "username: Username must be alphanumeric; password: String must contain at least 8 character(s)",
    );
    // No own function properties — that is what breaks the framework's serializer.
    expect(Object.values(caught as object).some((v) => typeof v === "function")).toBe(false);
  });
});
