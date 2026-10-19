import { DriverAdapterError } from "@prisma/driver-adapter-utils";
import { Prisma } from "./generated/prisma/client.js";
export function retryableTransactionError(error: unknown): boolean {
  return (
    (error instanceof DriverAdapterError &&
      error.cause.kind === "TransactionWriteConflict") ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      ["P2034", "P2002"].includes(error.code))
  );
}
