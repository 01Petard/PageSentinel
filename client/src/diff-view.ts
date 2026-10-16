import type { DiffPart } from "../../shared/types";

export interface DiffCell {
  number: number;
  text: string;
  changed: boolean;
}
export interface SplitDiffRow {
  before: DiffCell | null;
  after: DiffCell | null;
}
export interface UnifiedDiffRow {
  beforeNumber: number | null;
  afterNumber: number | null;
  text: string;
  kind: "context" | "added" | "removed";
}

export function buildDiffView(parts: DiffPart[]) {
  const unified: UnifiedDiffRow[] = [],
    split: SplitDiffRow[] = [],
    additions: string[] = [];
  let beforeNumber = 1,
    afterNumber = 1,
    addedCount = 0,
    removedCount = 0;
  let removed: DiffCell[] = [],
    added: DiffCell[] = [];
  // Adjacent removed/added blocks describe one edit. Pair their rows and leave
  // explicit gaps so unequal blocks cannot shift the following unchanged lines.
  function flushEdit() {
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      split.push({ before: removed[i] ?? null, after: added[i] ?? null });
    removed = [];
    added = [];
  }
  for (const part of parts) {
    if (!part.value) continue;
    const text = part.value.replace(/\n$/, "");
    const lines = text.split("\n");
    if (part.added) {
      additions.push(text);
      addedCount += lines.length;
      for (const line of lines) {
        const cell = { number: afterNumber++, text: line, changed: true };
        added.push(cell);
        unified.push({
          beforeNumber: null,
          afterNumber: cell.number,
          text: line,
          kind: "added",
        });
      }
    } else if (part.removed) {
      removedCount += lines.length;
      for (const line of lines) {
        const cell = { number: beforeNumber++, text: line, changed: true };
        removed.push(cell);
        unified.push({
          beforeNumber: cell.number,
          afterNumber: null,
          text: line,
          kind: "removed",
        });
      }
    } else {
      flushEdit();
      for (const line of lines) {
        const before = { number: beforeNumber++, text: line, changed: false };
        const after = { number: afterNumber++, text: line, changed: false };
        split.push({ before, after });
        unified.push({
          beforeNumber: before.number,
          afterNumber: after.number,
          text: line,
          kind: "context",
        });
      }
    }
  }
  flushEdit();
  return { unified, split, additions, addedCount, removedCount };
}
