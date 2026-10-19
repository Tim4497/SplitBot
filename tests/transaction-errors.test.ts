import { expect, it } from "vitest";
import { DriverAdapterError } from "@prisma/driver-adapter-utils";
import { Prisma } from "../src/generated/prisma/client.js";
import { retryableTransactionError } from "../src/transaction-errors.js";
it("retries Prisma transaction and unique-key race errors", () => {
  for (const code of ["P2034", "P2002"]) {
    expect(
      retryableTransactionError(
        new Prisma.PrismaClientKnownRequestError("Conflict", {
          code,
          clientVersion: "7.10.1",
        }),
      ),
    ).toBe(true);
  }
});
it("retries driver-level serialization errors raised at COMMIT", () => {
  expect(
    retryableTransactionError(
      new DriverAdapterError({ kind: "TransactionWriteConflict" }),
    ),
  ).toBe(true);
});
it("does not retry authentication, connection or arbitrary errors", () => {
  expect(
    retryableTransactionError(
      new DriverAdapterError({ kind: "AuthenticationFailed", user: "test" }),
    ),
  ).toBe(false);
  expect(retryableTransactionError(new Error("TransactionWriteConflict"))).toBe(
    false,
  );
  expect(retryableTransactionError(null)).toBe(false);
});
