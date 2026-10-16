import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDiffView } from "../client/src/diff-view.js";

test("split diff aligns replacements and keeps independent old/new line numbers", () => {
  const result = buildDiffView([
    { value: "标题\n" },
    { value: "旧价格 99\n旧说明\n", removed: true },
    { value: "新价格 79\n", added: true },
    { value: "共同结尾\n" },
    { value: "新功能\n", added: true },
  ]);
  assert.deepEqual(
    result.split.map((row) => [
      row.before?.number ?? null,
      row.before?.text ?? null,
      row.after?.number ?? null,
      row.after?.text ?? null,
    ]),
    [
      [1, "标题", 1, "标题"],
      [2, "旧价格 99", 2, "新价格 79"],
      [3, "旧说明", null, null],
      [4, "共同结尾", 3, "共同结尾"],
      [null, null, 4, "新功能"],
    ],
  );
  assert.deepEqual(result.additions, ["新价格 79", "新功能"]);
  assert.equal(result.addedCount, 2);
  assert.equal(result.removedCount, 2);
  assert.equal(result.unified.length, 6);
});

test("addition-only, deletion-only, blank lines and unsafe-looking text remain literal", () => {
  const added = buildDiffView([
    { value: "<script>alert(1)</script>\n\n最后一行", added: true },
  ]);
  assert.equal(added.addedCount, 3);
  assert.equal(added.split[0].before, null);
  assert.equal(added.split[1].after?.text, "");
  assert.equal(added.split[2].after?.text, "最后一行");
  const deleted = buildDiffView([{ value: "仅删除\n", removed: true }]);
  assert.deepEqual(deleted.additions, []);
  assert.equal(deleted.removedCount, 1);
  assert.equal(deleted.split[0].after, null);
  assert.deepEqual(buildDiffView([]).split, []);
  assert.equal(buildDiffView([{ value: "" }]).unified.length, 0);
});
