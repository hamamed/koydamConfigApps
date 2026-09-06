/**
 * Runs `worker` over `items` with a bounded number of parallel executions.
 * Keeps detail-page fetching polite without serialising the whole crawl.
 * Rejections are captured per item so one bad page cannot abort the batch.
 * @returns {Promise<Array<{item: unknown, value?: unknown, error?: Error}>>}
 */
export async function mapWithConcurrency(items, worker, concurrency = 2) {
  const queue = [...items]
  const results = []

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      try {
        results.push({ item, value: await worker(item) })
      } catch (error) {
        results.push({ item, error })
      }
    }
  })

  await Promise.all(runners)
  return results
}
