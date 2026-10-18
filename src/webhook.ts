import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Bot } from "grammy";
const hash = (s: string) => createHash("sha256").update(s).digest();
export function authorized(
  header: string | string[] | undefined,
  secret: string,
): boolean {
  return (
    typeof header === "string" && timingSafeEqual(hash(header), hash(secret))
  );
}
export function webhookServer(
  bot: Bot,
  secret: string,
  path: string,
  healthy: () => Promise<boolean>,
) {
  return createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      const ok = await healthy().catch(() => false);
      res.writeHead(ok ? 200 : 503);
      res.end(ok ? "ok" : "unavailable");
      return;
    }
    if (req.method !== "POST" || req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req.headers["x-telegram-bot-api-secret-token"], secret)) {
      res.writeHead(401).end();
      return;
    }
    if (!req.headers["content-type"]?.startsWith("application/json")) {
      res.writeHead(415).end();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const part of req) {
        const chunk = Buffer.from(part);
        size += chunk.length;
        if (size > 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      let update;
      try {
        update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!update || !Number.isSafeInteger(update.update_id)) {
        res.writeHead(400).end();
        return;
      }
      await bot.handleUpdate(update);
      res.writeHead(200).end("ok");
    } catch {
      console.error("webhook_update_failed");
      if (!res.headersSent) res.writeHead(503);
      res.end();
    }
  });
}
