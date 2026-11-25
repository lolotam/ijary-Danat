import { describe, expect, it } from "vitest";

import { insuranceErrorKey } from "./insuranceErrors";

describe("insuranceErrorKey", () => {
  it("explains a second insurance record on the same contract", () => {
    const error = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "insurance_payments_contract_id_key"',
    };
    expect(insuranceErrorKey(error)).toBe("insurance.contractAlreadyInsured");
  });

  it("leaves other unique violations to the caller's fallback", () => {
    const error = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "refunds_code_key"',
    };
    expect(insuranceErrorKey(error)).toBeNull();
  });
});
