import { createDatabase } from "./database.js";
import "dotenv/config";
import { createBot } from "./bot.js";
import { config } from "./config.js";
import { webhookServer } from "./webhook.js";
const cfg = config(),
  db = createDatabase(),
  bot = createBot(cfg.token, db);
const updates = [
  "inline_query",
  "chosen_inline_result",
  "callback_query",
] as const;
await db.$connect();
await bot.init();
let server: ReturnType<typeof webhookServer> | undefined;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (bot.isRunning()) await bot.stop();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await db.$disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
if (cfg.mode === "webhook") {
  const url = new URL(cfg.webhookUrl!);
  if (url.search || url.hash || url.pathname === "/healthz")
    throw new Error(
      "WEBHOOK_URL must have a dedicated path without query or fragment.",
    );
  server = webhookServer(bot, cfg.webhookSecret!, url.pathname, async () => {
    await db.$queryRaw`SELECT 1`;
    return true;
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(cfg.port, "0.0.0.0", resolve);
  });
  await bot.api.setWebhook(cfg.webhookUrl!, {
    secret_token: cfg.webhookSecret!,
    allowed_updates: [...updates],
    drop_pending_updates: false,
  });
  console.info("webhook_ready");
} else {
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  bot.catch(() => console.error("polling_update_failed"));
  console.info("polling_ready");
  await bot.start({ allowed_updates: [...updates] });
}
