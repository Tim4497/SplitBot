import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/database.js";

describe.skipIf(!process.env.DATABASE_URL)(
  "PostgreSQL schema selection",
  () => {
    it("routes model queries to the schema in DATABASE_URL", async () => {
      const admin = createDatabase();
      const schema = `test_${randomUUID().replaceAll("-", "")}`;
      const url = new URL(process.env.DATABASE_URL!);
      const source = url.searchParams.get("schema") ?? "public";
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(source))
        throw new Error("Invalid test schema");
      url.searchParams.set("schema", schema);
      const scoped = createDatabase(url.toString());
      const telegramId = 80800088n;
      try {
        await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        await admin.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."User" (LIKE "${source}"."User" INCLUDING ALL)`,
        );
        await scoped.user.create({
          data: { telegramId, displayName: "Scoped" },
        });
        const rows = await admin.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT count(*) AS count FROM "${schema}"."User"`,
        );
        expect(rows[0]?.count).toBe(1n);
        expect(
          await admin.user.findUnique({ where: { telegramId } }),
        ).toBeNull();
      } finally {
        await scoped.$disconnect();
        await admin.user.deleteMany({ where: { telegramId } });
        await admin.$executeRawUnsafe(
          `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
        );
        await admin.$disconnect();
      }
    });
  },
);
