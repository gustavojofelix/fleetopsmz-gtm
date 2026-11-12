/**
 * Runs `worker` over `items` with at most `limit` running at once. Results
 * keep the order of `items`. The worker must not throw: agents return failures
 * as values, so one failing record never stops the batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('concurrency limit must be a positive integer');
  }
  const results = new Array<R>(items.length);
  let next = 0;
  async function drain(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index] as T, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return results;
}
