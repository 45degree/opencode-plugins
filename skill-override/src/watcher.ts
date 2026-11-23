export interface Poller {
  stop(): Promise<void>
}

// Fixed-interval poller that never overlaps ticks: while one tick is still
// settling, later interval fires are skipped instead of queued.
export function startPolling(intervalMs: number, tick: () => Promise<void>): Poller {
  let stopping = false
  let inFlight: Promise<void> | undefined
  const timer = setInterval(() => {
    if (stopping || inFlight !== undefined) return
    inFlight = tick()
      .catch((error: unknown) => {
        console.warn("[skill-override]", "refresh failed", error instanceof Error ? error.message : error)
      })
      .finally(() => {
        inFlight = undefined
      })
  }, intervalMs)
  timer.unref?.()
  return {
    stop: async () => {
      stopping = true
      clearInterval(timer)
      if (inFlight !== undefined) await inFlight
    },
  }
}
