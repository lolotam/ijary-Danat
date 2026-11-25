import { describe, expect, it } from "vitest";

import { isPermanentQueryError, MAX_QUERY_RETRIES, shouldRetryQuery } from "./queryRetry";

describe("shouldRetryQuery", () => {
  /**
   * The case that prompted this. `custom_roles` does not exist in production,
   * so PostgREST answers PGRST205 on every attempt and React Query's default
   * turned one screen visit into thirteen identical requests.
   */
  it("does not retry a table missing from the schema cache", () => {
    const error = { code: "PGRST205", message: "Could not find the table 'public.custom_roles'" };

    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it.each([
    ["an RPC that does not exist", { code: "PGRST202" }],
    ["an undefined table reported by its SQLSTATE", { code: "42P01" }],
    ["a refused privilege", { code: "42501" }],
    ["an integrity violation", { code: "23505" }],
    ["a 404", { status: 404 }],
    ["a 403", { status: 403 }],
  ])("does not retry %s", (_scenario, error) => {
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  /**
   * A refresh does produce a new token, so this one really can succeed on the
   * next attempt — it is the exception among PostgREST's own codes.
   */
  it("retries an expired JWT", () => {
    expect(shouldRetryQuery(0, { code: "PGRST301", message: "JWT expired" })).toBe(true);
  });

  it.each([408, 425, 429, 504])("retries a %i, which is timing rather than a refusal", (status) => {
    expect(shouldRetryQuery(0, { status, message: "later" })).toBe(true);
  });

  it("retries a dropped connection, which carries no code at all", () => {
    expect(shouldRetryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
  });

  it("retries a gateway error", () => {
    expect(shouldRetryQuery(0, { status: 502, message: "Bad Gateway" })).toBe(true);
  });

  it.each([
    ["could not connect to the database", "PGRST000"],
    ["an internal connection-pool error", "PGRST001"],
    ["a schema cache that failed to load", "PGRST002"],
    ["a request that timed out", "PGRST003"],
  ])("retries %s, which is PostgREST's own infrastructure", (_scenario, code) => {
    expect(shouldRetryQuery(0, { code })).toBe(true);
  });

  /**
   * query-core 5.101.1 calls the predicate before incrementing its counter, so
   * the first failure arrives as 0. Asserting from 0 is the whole point: the
   * original test started at 1 and let a three-retry off-by-one through.
   */
  it("allows exactly MAX_QUERY_RETRIES further attempts, counting from zero", () => {
    const error = new TypeError("Failed to fetch");
    const allowed = [0, 1, 2, 3, 4].filter((count) => shouldRetryQuery(count, error));

    expect(allowed).toEqual([0, 1]);
    expect(allowed).toHaveLength(MAX_QUERY_RETRIES);
  });

  it("treats a null error as transient rather than crashing on it", () => {
    expect(isPermanentQueryError(null)).toBe(false);
    expect(isPermanentQueryError(undefined)).toBe(false);
  });
});
