import { test } from "node:test";
import assert from "node:assert/strict";
import { claimNotificationResults } from "../client/src/notification-delivery.js";

test("tabs with different initial cursors deliver each later result without losing earlier pending IDs", () => {
  const b = claimNotificationResults([{ id: 102 }], []);
  assert.deepEqual(
    b.fresh.map((x) => x.id),
    [102],
  );
  const a = claimNotificationResults(
    [{ id: 101 }, { id: 102 }],
    b.deliveredIds,
  );
  assert.deepEqual(
    a.fresh.map((x) => x.id),
    [101],
  );
  const repeat = claimNotificationResults(
    [{ id: 101 }, { id: 102 }, { id: 103 }],
    a.deliveredIds,
  );
  assert.deepEqual(
    repeat.fresh.map((x) => x.id),
    [103],
  );
  assert.equal(
    claimNotificationResults([{ id: 103 }], repeat.deliveredIds).fresh.length,
    0,
  );
});
test("delivery claims are bounded and preserve the most recent result IDs", () => {
  const result = claimNotificationResults(
    [{ id: 2000 }],
    Array.from({ length: 1200 }, (_, i) => i + 1),
  );
  assert.equal(result.deliveredIds.length, 1000);
  assert.equal(result.deliveredIds[0], 2000);
});

test("cleared results stay dismissed while new results remain eligible for notification", () => {
  const pending = [{ id: 100 }, { id: 101 }, { id: 102 }];
  const result = claimNotificationResults(pending, [], 101);
  assert.deepEqual(
    result.fresh.map((item) => item.id),
    [102],
  );
  assert.deepEqual(
    claimNotificationResults(pending, result.deliveredIds, 101).fresh,
    [],
  );
  assert.deepEqual(
    claimNotificationResults([{ id: 103 }], result.deliveredIds, 101).fresh.map(
      (item) => item.id,
    ),
    [103],
  );
});
