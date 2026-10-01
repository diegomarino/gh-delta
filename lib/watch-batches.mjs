export function prBatches(numbers) {
  const unique = [...new Set(numbers)];
  if (!unique.every((number) => Number.isSafeInteger(number) && number > 0))
    throw new Error('targeted PR fetch requires positive integer numbers');
  unique.sort((a, b) => a - b);
  const batches = [];
  for (let index = 0; index < unique.length; index += 10)
    batches.push(unique.slice(index, index + 10));
  return batches;
}

export function admitBatch({ remaining, floor, batchesStillNeeded }) {
  return remaining - floor >= batchesStillNeeded;
}
