/**
 * Global sleep scheduler for aria-memory integration.
 *
 * Periodically checks whether to trigger a global_sleep operation,
 * which compacts and maintains the aria-memory knowledge base.
 *
 * Trigger conditions (all must be met):
 *   a. Last global_sleep was > cooldownMs ago (default 6h)
 *   b. No active agent sessions in SessionManager
 *   c. There are pending wrapups in aria-memory meta.json
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { logger } from './logger.js';
import { ARIA_MEMORY_DIR, META_PATH } from './meta-lock.js';
import {
  releaseMemoryWork,
  tryAcquireMemoryWork,
} from './memory-maintenance.js';

// execFile (no shell) so the prompt argv element is passed verbatim — real
// newlines and special characters are preserved exactly. Same rationale as
// the wrapup consumer; both spawn paths use the same approach.
const execFileAsync = promisify(execFile);

export interface GlobalSleepConfig {
  /** Check interval in ms (default: 30min) */
  checkIntervalMs: number;
  /**
   * Minimum time between global_sleep runs in ms (default: 6h). This is the
   * floor — sleep never fires more often than this even if other conditions
   * keep firing. Mirrors `/memory-auto-maintain`'s 6h cadence.
   */
  cooldownMs: number;
  /**
   * Strong-trigger heuristic copied from aria-memory's own SessionStart hook
   * (hooks/session-start.sh: `if [ "$UNPROCESSED" -ge 2 ] || [ "$HOURS_AGO"
   * -ge 12 ]`). Sleep fires when *either* there are at least this many new
   * impression files since the last sleep, *or* enough wall-clock time has
   * passed regardless of new work. Cooldown still gates the floor.
   */
  minNewImpressions: number;
  /** See minNewImpressions. Default 12h. */
  staleAfterMs: number;
  /**
   * If set, sleep defers (skips the tick) whenever pendingWrapups.length is
   * at or above this value — i.e. wrapup consumer would want to fire on its
   * own tick, and the queue should drain first before the heavier sleep pass
   * runs. Set to the wrapup consumer's pendingThreshold at wire-up time in
   * index.ts. Omit or set to 0 to disable deferral.
   */
  deferToWrapupAbove?: number;
}

/**
 * Count `.md` files in `<aria-memory>/impressions/` whose mtime is strictly
 * greater than `sinceMs`. Used as the "new impressions since last sleep"
 * signal for the strong trigger heuristic. Returns 0 on missing dir or any
 * I/O error — the caller treats absence-of-evidence as "no new work".
 */
async function countNewImpressions(
  impressionsDir: string,
  sinceMs: number,
): Promise<number> {
  if (!existsSync(impressionsDir)) return 0;
  let count = 0;
  try {
    const names = await readdir(impressionsDir);
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      try {
        const s = await stat(pathResolve(impressionsDir, name));
        if (s.isFile() && s.mtimeMs > sinceMs) count += 1;
      } catch {
        /* ignore individual file errors */
      }
    }
  } catch {
    /* ignore — treat as 0 */
  }
  return count;
}

type HasActiveSessionsFn = () => boolean;

export class GlobalSleepScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly config: GlobalSleepConfig;
  private readonly hasActiveSessions: HasActiveSessionsFn;

  constructor(config: GlobalSleepConfig, hasActiveSessions: HasActiveSessionsFn) {
    this.config = config;
    this.hasActiveSessions = hasActiveSessions;
  }

  start(): void {
    if (this.timer) return;
    logger.info(
      {
        checkInterval: `${this.config.checkIntervalMs / 60_000}min`,
        cooldown: `${this.config.cooldownMs / 3_600_000}h`,
      },
      'GlobalSleepScheduler started',
    );

    // Run first check shortly after startup, then on interval
    setTimeout(() => this.tick(), 5_000);
    this.timer = setInterval(() => this.tick(), this.config.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('GlobalSleepScheduler stopped');
  }

  /** Single check-and-maybe-run cycle. */
  async tick(): Promise<void> {
    if (this.running) {
      logger.debug('GlobalSleep tick skipped: already running');
      return;
    }

    // Atomically claim the shared maintenance slot BEFORE any await. See
    // memory-maintenance.ts for the rationale — putting any await between
    // the inProgress check and the assignment opens a race window where
    // wrapup and sleep can both spawn claude subprocesses against the same
    // meta.json. The acquire is a synchronous read-then-write, so it's
    // atomic relative to other event-loop turns.
    if (!tryAcquireMemoryWork('sleep')) {
      logger.debug('GlobalSleep tick skipped: other memory work in progress');
      return;
    }

    try {
      this.running = true;

      if (!existsSync(ARIA_MEMORY_DIR) || !existsSync(META_PATH)) {
        logger.debug('GlobalSleep tick skipped: aria-memory not found');
        return;
      }

      const meta = JSON.parse(await readFile(META_PATH, 'utf-8'));

      // Condition a: cooldown elapsed
      // Read aria-memory's authoritative `lastGlobalSleepAt` field. The skill
      // only writes this on a real successful sleep, so we can trust it as the
      // single source of truth — no separate daemon-side timestamp needed.
      const lastSleep = meta.lastGlobalSleepAt
        ? new Date(meta.lastGlobalSleepAt).getTime()
        : 0;
      const elapsed = Date.now() - lastSleep;
      if (elapsed < this.config.cooldownMs) {
        logger.debug(
          { elapsedMin: Math.round(elapsed / 60_000) },
          'GlobalSleep tick skipped: cooldown not elapsed',
        );
        return;
      }

      // Condition b: no active sessions
      if (this.hasActiveSessions()) {
        logger.debug('GlobalSleep tick skipped: active sessions exist');
        return;
      }

      // Condition c: strong-trigger heuristic — mirrors aria-memory upstream.
      //
      // The OLD condition was "pending wrapups exist", which made sense when
      // sleep also implicitly consumed pending. Now that PendingWrapupConsumer
      // owns pending consumption, sleep needs its own signal for "is there
      // any new work to maintain?". We adopt the heuristic from
      // aria-memory/hooks/session-start.sh:
      //
      //     if [ "$UNPROCESSED" -ge 2 ] || [ "$HOURS_AGO" -ge 12 ]
      //
      // i.e. fire when at least N impressions are newer than the last sleep
      // OR enough wall-clock time has passed regardless. The cooldownMs check
      // above is the floor (default 6h); this is the trigger.
      const impressionsDir = pathResolve(ARIA_MEMORY_DIR, 'impressions');
      const newImpressions = await countNewImpressions(impressionsDir, lastSleep);
      const hoursElapsed = elapsed / 3_600_000;
      const stale = elapsed >= this.config.staleAfterMs;
      const enoughNew = newImpressions >= this.config.minNewImpressions;
      if (!enoughNew && !stale) {
        logger.debug(
          {
            newImpressions,
            minNewImpressions: this.config.minNewImpressions,
            hoursElapsed: Math.round(hoursElapsed),
            staleAfterHours: this.config.staleAfterMs / 3_600_000,
          },
          'GlobalSleep tick skipped: no new impressions and not stale',
        );
        return;
      }

      // Condition d: defer to wrapup consumer when pendingWrapups is full
      // enough that wrapup would want to fire. This realizes the "wrapup
      // first, sleep second" ordering requested by the daemon's maintenance
      // priority policy: if there's a queue waiting to be turned into
      // impressions, let wrapup convert it before sleep does its pass —
      // otherwise sleep runs against pre-wrapup state and would have to
      // re-run after wrapup creates a fresh batch of impressions.
      const pending: unknown[] = meta.pendingWrapups || [];
      const deferAbove = this.config.deferToWrapupAbove ?? 0;
      if (deferAbove > 0 && pending.length >= deferAbove) {
        logger.debug(
          { pendingCount: pending.length, threshold: deferAbove },
          'GlobalSleep tick skipped: deferring to wrapup consumer (pending >= threshold)',
        );
        return;
      }

      logger.info(
        {
          newImpressions,
          pendingCount: pending.length,
          lastSleepAge: `${Math.round(hoursElapsed)}h`,
          triggerReason: enoughNew ? 'newImpressions' : 'staleAfterMs',
        },
        'All conditions met, triggering global_sleep',
      );

      await this.executeGlobalSleep();
    } catch (err) {
      logger.error({ err }, 'GlobalSleep tick error');
    } finally {
      this.running = false;
      releaseMemoryWork('sleep');
    }
  }

  /**
   * Detect whether a claude -p stdout corresponds to a transient Anthropic API
   * overload (HTTP 529). The CLI surfaces these as human text in stdout with
   * exit code 0, so we can't rely on process exit status.
   */
  private isOverloadedResponse(stdout: string): boolean {
    const s = stdout.toLowerCase();
    return (
      s.includes('529') ||
      s.includes('overloaded') ||
      s.includes('overloaded_error')
    );
  }

  private async executeGlobalSleep(): Promise<void> {
    // Snapshot the canonical timestamp BEFORE invoking the skill so we can
    // tell whether a real sleep happened (the skill bumps lastGlobalSleepAt
    // only on success). We deliberately do NOT write a daemon-side timestamp:
    // doing that on a sandbox/error stdout would silently push the cooldown
    // forward and mask the failure.
    const beforeMeta = JSON.parse(await readFile(META_PATH, 'utf-8'));
    const beforeAt = beforeMeta.lastGlobalSleepAt ?? null;
    const beforePending = (beforeMeta.pendingWrapups ?? []).length;

    // Exponential backoff for transient API overload (529). Other failures
    // (sandbox errors, SIGTERM/timeout, etc.) are NOT retried here — the next
    // scheduler tick (~30min later) will pick them up naturally.
    //
    // Backoff schedule: 5s → 10s → 20s → 40s → 80s (≈155s total), well within
    // the 30min exec budget so a retry chain never starves the next tick.
    const maxAttempts = 5;
    const baseDelayMs = 5_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Two flags are critical for headless memory-sleep to actually work:
        //
        //   --permission-mode bypassPermissions
        //     In headless `-p` mode there's no interactive permission prompt,
        //     and settings.json's `Write(...)`/`Edit(...)` allow rules are NOT
        //     honored for file tools (verified empirically: with explicit
        //     `Write(/abs/path/**)` rules in settings.json, Write was still
        //     denied). Without this flag the memory-agent subagent reads files
        //     fine but every Write/Edit gets denied, so the 7-step maintenance
        //     completes its analysis but never lands any changes. This is a
        //     trusted internal automation operating on the user's own memory
        //     dir, so bypass is appropriate.
        //
        //   --no-session-persistence
        //     Prevents the spawned claude session from writing its transcript
        //     jsonl to ~/.claude/projects/.../*.jsonl. aria-memory's plugin
        //     SessionEnd hook reads transcript_path from the hook input and
        //     registers it as a new pendingWrapup; without this flag, every
        //     daemon-spawned /memory-sleep run becomes a new pendingWrapup,
        //     creating an infinite self-feeding loop. With the flag, the hook
        //     still fires but exits early because transcript_path doesn't
        //     exist on disk (see aria-memory hooks/session-end.sh `[ ! -f ]`
        //     guard).
        const args = [
          '--no-session-persistence',
          '--permission-mode',
          'bypassPermissions',
          '-p',
          '/memory-sleep',
          '--max-turns',
          '200',
          '--output-format',
          'text',
        ];
        const { stdout, stderr } = await execFileAsync('claude', args, {
          timeout: 1_800_000,
          cwd: homedir(),
          maxBuffer: 10 * 1024 * 1024,
        });

        if (stderr.trim()) {
          logger.warn({ stderr: stderr.trim().slice(0, 500) }, 'global_sleep stderr');
        }

        // Verify the skill actually ran by re-reading meta.json. If neither
        // lastGlobalSleepAt advanced nor pendingWrapups shrank, the skill
        // produced output but did no real work.
        const afterMeta = JSON.parse(await readFile(META_PATH, 'utf-8'));
        const afterAt = afterMeta.lastGlobalSleepAt ?? null;
        const afterPending = (afterMeta.pendingWrapups ?? []).length;
        const advanced = afterAt !== beforeAt;
        const consumed = afterPending < beforePending;

        if (advanced || consumed) {
          logger.info(
            {
              attempt,
              stdout: stdout.trim().slice(0, 500),
              advanced,
              consumed,
              pendingBefore: beforePending,
              pendingAfter: afterPending,
              lastGlobalSleepAt: afterAt,
            },
            'global_sleep completed',
          );
          return;
        }

        // No-op result: decide whether to retry based on whether stdout looks
        // like a transient 529 overload.
        if (this.isOverloadedResponse(stdout) && attempt < maxAttempts) {
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
          logger.warn(
            {
              attempt,
              nextDelayMs: delayMs,
              stdout: stdout.trim().slice(0, 500),
            },
            'global_sleep hit Anthropic API 529 overloaded — retrying with exponential backoff',
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        logger.warn(
          {
            attempt,
            stdout: stdout.trim().slice(0, 500),
            pendingBefore: beforePending,
            pendingAfter: afterPending,
          },
          'global_sleep ran but had no effect (skill returned without bumping lastGlobalSleepAt or consuming pendingWrapups) — leaving cooldown untouched so the next tick will retry',
        );
        return;
      } catch (err) {
        // Process-level failure (timeout/SIGTERM/spawn error). Don't retry
        // in-process; surface and let the next scheduler tick handle it.
        logger.error({ err, attempt }, 'global_sleep execution failed');
        return;
      }
    }
  }
}
