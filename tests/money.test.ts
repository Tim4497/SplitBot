import { describe, expect, it } from "vitest";
import {
  parseQuery,
  split,
  splitByPercent,
  euro,
  delta,
} from "../src/money.js";
describe("money", () => {
  it.each(["12,50 Essen", "12.50 Essen", "12,50€ Essen", "12.50 EUR Essen"])(
    "%s",
    (q) =>
      expect(parseQuery(q)).toEqual({
        kind: "EXPENSE",
        amount: 1250,
        description: "Essen",
      }),
  );
  it("recognizes integer euros and settlements", () => {
    expect(parseQuery("12€ Taxi").amount).toBe(1200);
    expect(parseQuery("ausgleich 12")).toEqual({
      kind: "SETTLEMENT",
      amount: 1200,
      description: "Ausgleich",
    });
  });
  it.each([
    "0 Pizza",
    "-1 Pizza",
    "1e3 Pizza",
    "12,345 Pizza",
    "NaN Pizza",
    "1.000,50 Pizza",
    "10000001 Pizza",
    "12",
    "ausgleich 1 extra",
  ])("rejects %s", (q) => expect(() => parseQuery(q)).toThrow());
  it("payer absorbs the extra cent", () => {
    expect(split(1001, true)).toEqual([501, 500]);
    expect(split(1001, false)).toEqual([500, 501]);
    expect(split(1, true)).toEqual([1, 0]);
  });
  it("splits expenses by payer percentage with exact cents", () => {
    expect(splitByPercent(10_001, true, 70)).toEqual([7_001, 3_000]);
    expect(splitByPercent(10_001, false, 70)).toEqual([3_000, 7_001]);
    expect(splitByPercent(100, true, 0)).toEqual([0, 100]);
    expect(splitByPercent(100, true, 100)).toEqual([100, 0]);
  });
  it("runs the full permanent-ledger example with exact signed cents", () => {
    let b = delta("EXPENSE", 4000, true);
    expect(b).toBe(2000n);
    b += delta("EXPENSE", 1600, false);
    expect(b).toBe(1200n);
    b += delta("SETTLEMENT", 1200, false);
    expect(b).toBe(0n);
    b += delta("EXPENSE", 1000, true);
    expect(b).toBe(500n);
    expect(euro(b)).toBe("5,00 €");
  });
});
