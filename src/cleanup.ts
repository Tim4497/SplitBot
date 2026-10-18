import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { cleanup } from "./maintenance.js";
const db = new PrismaClient();
try {
  await cleanup(db);
  console.info("cleanup_complete");
} finally {
  await db.$disconnect();
}
