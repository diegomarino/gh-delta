const ENTITY_RANK = { pr: 0, issue: 1 };

/**
 * Split a watch membership into deterministic requests of at most ten items.
 * Order is canonical entity (`pr` then `issue`) then number. Identity is
 * `(entity, number)`, so the same number may appear once per entity.
 *
 * @param {{ entity: 'pr' | 'issue', number: number }[]} items
 */
export function watchBatches(items) {
  if (!Array.isArray(items)) throw new Error('targeted watch batches require an item list');
  const unique = [];
  const seen = new Set();
  for (const item of items) {
    if (item?.entity !== 'pr' && item?.entity !== 'issue')
      throw new Error('targeted watch batches require pr or issue items');
    if (!Number.isSafeInteger(item.number) || item.number <= 0)
      throw new Error('targeted watch batches require positive integer numbers');
    const key = `${item.entity}:${item.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ entity: item.entity, number: item.number });
  }
  unique.sort((a, b) => ENTITY_RANK[a.entity] - ENTITY_RANK[b.entity] || a.number - b.number);
  const batches = [];
  for (let index = 0; index < unique.length; index += 10)
    batches.push(unique.slice(index, index + 10));
  return batches;
}

export function prBatches(numbers) {
  const unique = [...new Set(numbers)];
  if (!unique.every((number) => Number.isSafeInteger(number) && number > 0))
    throw new Error('targeted PR fetch requires positive integer numbers');
  unique.sort((a, b) => a - b);
  return watchBatches(unique.map((number) => ({ entity: 'pr', number }))).map((batch) =>
    batch.map((item) => item.number),
  );
}

export function admitBatch({ remaining, floor, batchesStillNeeded }) {
  return remaining - floor >= batchesStillNeeded;
}
