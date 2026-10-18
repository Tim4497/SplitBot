import { describe, it, expect } from "vitest";
import { config } from "../src/config.js";
import { authorized } from "../src/webhook.js";
describe("webhook security", () => {
  it("requires strong secret and HTTPS in webhook mode", () => {
    const e = {
      BOT_TOKEN: "123:abc",
      DATABASE_URL: "postgresql://localhost/db",
      BOT_MODE: "webhook",
    };
    expect(() => config(e)).toThrow();
    expect(() =>
      config({
        ...e,
        WEBHOOK_URL: "http://localhost",
        WEBHOOK_SECRET: "a".repeat(32),
      }),
    ).toThrow();
    expect(
      config({
        ...e,
        WEBHOOK_URL: "https://example.test/telegram",
        WEBHOOK_SECRET: "a".repeat(32),
      }).mode,
    ).toBe("webhook");
  });
  it("rejects missing, array and incorrect authentication headers", () => {
    expect(authorized(undefined, "secret")).toBe(false);
    expect(authorized(["secret"], "secret")).toBe(false);
    expect(authorized("wrong", "secret")).toBe(false);
    expect(authorized("secret", "secret")).toBe(true);
  });
});
