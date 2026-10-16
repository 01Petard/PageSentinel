import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCountdown } from "../client/src/api.js";

test("countdown uses hours and minutes, rounds remaining fractions up and never becomes negative", () => {
  const now = 1_000_000;
  assert.equal(formatCountdown(now + 67 * 60_000, now), "1时7分");
  assert.equal(formatCountdown(now + 60 * 60_000, now), "1时0分");
  assert.equal(formatCountdown(now + 24 * 60 * 60_000, now), "24时0分");
  assert.equal(formatCountdown(now + 59_999, now), "0时1分");
  assert.equal(formatCountdown(now, now), "0时0分");
  assert.equal(formatCountdown(now - 60_000, now), "0时0分");
});
