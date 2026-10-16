import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeText,
  normalizeItem,
  compareText,
  unseenItems,
} from "../server/src/monitor/comparator.js";

test("TEXT only normalizes whitespace and keeps meaningful numbers and dates", () => {
  assert.equal(
    normalizeText("  版本  v2.0  \r\n\n  2026-10-16\t价格 99  "),
    "版本 v2.0\n2026-10-16 价格 99",
  );
  assert.equal(compareText("版本 v1", "版本 v2").changed, true);
  assert.ok(
    compareText("版本 v1", "版本 v2").diff.some(
      (x) => x.added && x.value.includes("v2"),
    ),
  );
  assert.equal(compareText("a  b", "a b").changed, false);
});

test("LIST retains query strings, drops fragments and uses the whole history", () => {
  const a = normalizeItem("A", "/a?q=1#old", "https://example.com/list");
  assert.equal(a.url, "https://example.com/a?q=1");
  assert.notEqual(
    a.key,
    normalizeItem("A", "/a?q=2", "https://example.com").key,
  );
  const c = normalizeItem("C", "/c", "https://example.com");
  assert.deepEqual(unseenItems([c, a], new Set([a.key, c.key])), []);
  assert.throws(() =>
    normalizeItem("X", "javascript:alert(1)", "https://example.com"),
  );
});
