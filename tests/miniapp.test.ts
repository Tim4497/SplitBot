import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyTelegramInitData } from "../src/miniapp.js";

function initData(token: string, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    user: JSON.stringify({ id: 12345, first_name: "Anna" }),
  });
  const check = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

describe("Mini App Telegram authorization", () => {
  it("accepts authentic, recent Telegram init data", () => {
    expect(verifyTelegramInitData(initData("123:token"), "123:token")).toEqual({
      id: 12345,
      first_name: "Anna",
    });
  });

  it("rejects tampered, expired and missing init data", () => {
    const signed = initData("123:token");
    expect(() =>
      verifyTelegramInitData(signed.replace("Anna", "Max"), "123:token"),
    ).toThrow();
    expect(() =>
      verifyTelegramInitData(
        initData("123:token", Math.floor(Date.now() / 1000) - 86_401),
        "123:token",
      ),
    ).toThrow();
    expect(() => verifyTelegramInitData(undefined, "123:token")).toThrow();
  });
});
