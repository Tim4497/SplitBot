import { createDatabase } from "./database.js";
import "dotenv/config";
import { cleanup } from "./maintenance.js";
const db = createDatabase();
try {
  await cleanup(db);
  console.info("cleanup_complete");
} finally {
  await db.$disconnect();
}
