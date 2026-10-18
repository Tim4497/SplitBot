import { it, expect, vi, afterEach } from "vitest";
import { rateLimit } from "../src/rate-limit.js";
afterEach(() => vi.useRealTimers());
it("expires capacity entries so new identities are not locked out", () => {
  vi.useFakeTimers();
  const allow = rateLimit();
  for (let i = 1; i <= 10000; i++) expect(allow(i)).toBe(true);
  expect(allow(10001)).toBe(false);
  vi.advanceTimersByTime(60001);
  expect(allow(10001)).toBe(true);
});
it("limits repeated requests and resets the time window", () => {
  vi.useFakeTimers();
  const allow = rateLimit();
  for (let i = 0; i < 90; i++) expect(allow(1)).toBe(true);
  expect(allow(1)).toBe(false);
  vi.advanceTimersByTime(60001);
  expect(allow(1)).toBe(true);
});
