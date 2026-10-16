// Track individual results: tabs may start at different feed cursors and receive
// newer results before another tab has delivered an earlier result.
export function claimNotificationResults<T extends { id: number }>(
  pending: T[],
  deliveredIds: number[],
  clearedThrough = 0,
) {
  const delivered = new Set(deliveredIds);
  const fresh = pending
    .filter((item) => item.id > clearedThrough && !delivered.has(item.id))
    .sort((a, b) => a.id - b.id);
  for (const item of fresh) delivered.add(item.id);
  return {
    fresh,
    deliveredIds: [...delivered].sort((a, b) => b - a).slice(0, 1000),
  };
}
