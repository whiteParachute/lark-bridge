/**
 * Shared coordination for memory maintenance jobs in lark-bridge daemon.
 *
 * Two schedulers — PendingWrapupConsumer (consumes aria-memory pending
 * wrapups) and GlobalSleepScheduler (runs the 7-step maintenance) — both
 * spawn heavyweight `claude -p` subprocesses that touch the same
 * ~/.aria-memory/meta.json. Running them concurrently would race on writes
 * and waste compute. This module provides a single module-level slot that
 * both schedulers must claim before firing.
 *
 * **Atomicity invariant** — `tryAcquireMemoryWork` performs a synchronous
 * read-then-write on the module-level flag with NO `await` between the
 * check and the assignment. In single-threaded JS this is atomic relative
 * to other event-loop turns: once a tick observes `null` and writes its
 * kind, no other tick can squeeze in. Callers MUST do all their await work
 * AFTER the acquire, not before. An earlier design used a separate getter
 * + setter and slipped `await readFile(...)` in between, which left a race
 * window where both schedulers could observe `null` and both spawn claude
 * subprocesses against the same meta.json (caught in code review).
 *
 * Priority model:
 *   - Wrapup takes priority over sleep. Sleep's tick skips when ANY work
 *     is in progress, AND also when pendingWrapups is at/above wrapup's
 *     threshold (i.e. wrapup is "about to fire"), so the queue drains
 *     before the heavy sleep pass runs.
 *   - Wrapup's tick skips when sleep is already running (don't interrupt
 *     a job in flight). Next wrapup tick picks up.
 */
export type MemoryWorkKind = 'wrapup' | 'sleep';

let inProgress: MemoryWorkKind | null = null;

/**
 * Atomically try to claim the shared maintenance slot for `kind`.
 *
 * Returns `true` if the slot was free and is now held by `kind` — caller
 * MUST eventually call `releaseMemoryWork(kind)` (typically in a `finally`)
 * to free it. Returns `false` if some other kind is already holding the
 * slot, in which case caller should skip this tick.
 *
 * Atomic in the JS event loop: the read of `inProgress` and the assignment
 * happen synchronously, so no other tick can interleave between them.
 */
export function tryAcquireMemoryWork(kind: MemoryWorkKind): boolean {
  if (inProgress !== null) return false;
  inProgress = kind;
  return true;
}

/**
 * Release the maintenance slot. No-op if `kind` doesn't currently hold it
 * (defensive: protects against double-release bugs).
 */
export function releaseMemoryWork(kind: MemoryWorkKind): void {
  if (inProgress === kind) inProgress = null;
}

/**
 * Read-only inspection of the current holder. Used by GlobalSleepScheduler's
 * `deferToWrapupAbove` check to peek at whether wrapup is queued (not the
 * primary mutex mechanism — that's `tryAcquireMemoryWork`).
 */
export function getMemoryWorkInProgress(): MemoryWorkKind | null {
  return inProgress;
}
