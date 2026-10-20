export type Config = {
  token: string;
  databaseUrl: string;
  mode: "polling" | "webhook";
  port: number;
  webhookUrl?: string;
  webhookSecret?: string;
  webAppUrl?: string;
};
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.BOT_TOKEN,
    databaseUrl = env.DATABASE_URL,
    mode = env.BOT_MODE ?? "polling";
  if (
    !token ||
    !/^\d+:[A-Za-z0-9_-]+$/.test(token) ||
    token.includes("REPLACE")
  )
    throw new Error("Set a valid BOT_TOKEN.");
  if (!databaseUrl?.startsWith("postgres"))
    throw new Error("Set DATABASE_URL to PostgreSQL.");
  if (mode !== "polling" && mode !== "webhook")
    throw new Error("BOT_MODE must be polling or webhook.");
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  if (mode === "webhook") {
    if (!env.WEBHOOK_URL || new URL(env.WEBHOOK_URL).protocol !== "https:")
      throw new Error("WEBHOOK_URL must use HTTPS.");
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.WEBHOOK_SECRET ?? ""))
      throw new Error("WEBHOOK_SECRET needs 32–256 URL-safe characters.");
  }
  if (env.WEB_APP_URL) {
    const appUrl = new URL(env.WEB_APP_URL);
    if (
      appUrl.protocol !== "https:" ||
      appUrl.pathname !== "/" ||
      appUrl.search ||
      appUrl.hash
    )
      throw new Error(
        "WEB_APP_URL must be a root HTTPS URL without query or fragment.",
      );
  }
  return {
    token,
    databaseUrl,
    mode,
    port,
    webhookUrl: env.WEBHOOK_URL,
    webhookSecret: env.WEBHOOK_SECRET,
    webAppUrl: env.WEB_APP_URL,
  };
}
