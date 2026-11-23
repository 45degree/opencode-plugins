/**
 * Admission and drain for the work one plugin instance starts.
 *
 * Cleanup closes admission first, so that nothing new begins, then waits for
 * everything that already did. A task is registered the moment it starts and
 * stays tracked until it settles, storage writes included.
 */
export class TaskPool {
  private readonly pending = new Set<Promise<unknown>>()
  private closed = false

  /** False once cleanup began: no round may start any more. */
  get isOpen(): boolean {
    return !this.closed
  }

  /** Track a task that just started. Returns the same promise. */
  track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task)
    const done = () => this.pending.delete(task)
    void task.then(done, done)
    return task
  }

  close(): void {
    this.closed = true
  }

  /** Resolve once every tracked task settled. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending])
    }
  }
}
