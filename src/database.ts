import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

/** Shared adapter configuration for the bot, maintenance commands and tests. */
export function createDatabase(connectionString = process.env.DATABASE_URL) {
  const schema = connectionString
    ? (new URL(connectionString).searchParams.get("schema") ?? "public")
    : "public";
  const adapter = new PrismaPg(
    {
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      max: 10,
    },
    { schema },
  );
  return new PrismaClient({ adapter });
}
