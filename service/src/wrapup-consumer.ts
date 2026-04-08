/**
 * Pending wrapup consumer scheduler.
 *
 * Periodically checks whether to trigger a batched wrapup operation that
 * consumes aria-memory's pendingWrapups queue. Uses the `processPending: true`
 * contract on aria-memory's memory-agent subagent (documented in
 * aria-memory's agents/memory-agent.md under "三、session_wrapup").
 *
 * Trigger conditions (all must be met):
 *   a. Last successful wrapup run was > cooldownMs ago (default 1h)
 *   b. No active feishu sessions in SessionManager
 *   c. pendingWrapups.length >= pendingThreshold (default 5)
 *   d. No other memory maintenance job (sleep) currently running
 *
 * On failure the cooldown timestamp is NOT advanced, so the next tick retries.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { logger } from './logger.js';
import { ARIA_MEMORY_DIR, META_PATH } from './meta-lock.js';
import {
  releaseMemoryWork,
  tryAcquireMemoryWork,
} from './memory-maintenance.js';

// execFile (no shell) so the prompt argv element is passed verbatim — real
// newlines and special characters are preserved exactly. exec() routes through
// `/bin/sh -c`, where embedded `\n` from JSON.stringify becomes a literal
// backslash-n instead of an actual line break.
const execFileAsync = promisify(execFile);

export interface WrapupConsumerConfig {
  /** How often to check conditions, in ms. */
  checkIntervalMs: number;
  /** Minimum time between successful wrapup runs, in ms. */
  cooldownMs: number;
  /**
   * Primary trigger: fire when pendingWrapups.length >= this. Set to a
   * value high enough to amortize the per-invocation claude startup cost
   * across multiple transcripts (default 5).
   */
  pendingThreshold: number;
  /**
   * Age-based fallback to keep low-volume queues from stalling. Fire when
   * the oldest pending entry is older than this, even if pendingThreshold
   * has not been reached. Without this, a steady-state of 1-4 pending
   * would never get drained until the queue piled up to threshold.
   * Default 6h, mirrors the global_sleep cooldown so latency stays bounded.
   */
  pendingMaxAgeMs: number;
}

type HasActiveSessionsFn = () => boolean;

export class PendingWrapupConsumer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** ms since epoch of the most recent *successful* wrapup run. 0 = never. */
  private lastRunAt = 0;
  private readonly config: WrapupConsumerConfig;
  private readonly hasActiveSessions: HasActiveSessionsFn;

  constructor(
    config: WrapupConsumerConfig,
    hasActiveSessions: HasActiveSessionsFn,
  ) {
    this.config = config;
    this.hasActiveSessions = hasActiveSessions;
  }

  start(): void {
    if (this.timer) return;
    logger.info(
      {
        checkInterval: `${this.config.checkIntervalMs / 60_000}min`,
        cooldown: `${this.config.cooldownMs / 60_000}min`,
        threshold: this.config.pendingThreshold,
      },
      'PendingWrapupConsumer started',
    );

    // Run first check shortly after startup, then on interval.
    setTimeout(() => this.tick(), 5_000);
    this.timer = setInterval(() => this.tick(), this.config.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('PendingWrapupConsumer stopped');
  }

  /** Single check-and-maybe-run cycle. */
  async tick(): Promise<void> {
    if (this.running) {
      logger.debug('WrapupConsumer tick skipped: already running');
      return;
    }

    // Atomically claim the shared maintenance slot BEFORE any await. This
    // closes a race window where wrapup and sleep ticks running in the
    // same event-loop phase could both observe `null` and both spawn a
    // claude subprocess against the same meta.json. The acquire is a
    // synchronous read-then-write on a module-level flag, so it's atomic
    // relative to other event-loop turns.
    if (!tryAcquireMemoryWork('wrapup')) {
      logger.debug('WrapupConsumer tick skipped: other memory work in progress');
      return;
    }

    try {
      this.running = true;

      if (!existsSync(ARIA_MEMORY_DIR) || !existsSync(META_PATH)) {
        logger.debug('WrapupConsumer tick skipped: aria-memory not found');
        return;
      }

      // Condition a: cooldown elapsed since last *successful* wrapup run.
      const elapsed = Date.now() - this.lastRunAt;
      if (this.lastRunAt > 0 && elapsed < this.config.cooldownMs) {
        logger.debug(
          { elapsedMin: Math.round(elapsed / 60_000) },
          'WrapupConsumer tick skipped: cooldown not elapsed',
        );
        return;
      }

      // Condition b: no active sessions.
      if (this.hasActiveSessions()) {
        logger.debug('WrapupConsumer tick skipped: active sessions exist');
        return;
      }

      // Condition c: trigger when EITHER pending hits threshold OR the
      // oldest pending entry has been waiting longer than pendingMaxAgeMs.
      // The age fallback prevents low-volume queues (1-4 pending) from
      // stalling indefinitely below the batching threshold.
      const meta = JSON.parse(await readFile(META_PATH, 'utf-8'));
      const pending: Array<{ recordedAt?: string }> = meta.pendingWrapups || [];
      const reachedThreshold = pending.length >= this.config.pendingThreshold;

      let agedOut = false;
      let oldestAgeMs = 0;
      if (!reachedThreshold && pending.length > 0) {
        // Find the oldest entry's recordedAt. Skip entries with malformed
        // or missing timestamps (defensive — shouldn't happen for entries
        // written by aria-memory's hook or lark-bridge, but be safe).
        let oldestTs = Number.POSITIVE_INFINITY;
        for (const p of pending) {
          if (!p.recordedAt) continue;
          const ts = new Date(p.recordedAt).getTime();
          if (Number.isFinite(ts) && ts < oldestTs) oldestTs = ts;
        }
        if (Number.isFinite(oldestTs)) {
          oldestAgeMs = Date.now() - oldestTs;
          agedOut = oldestAgeMs >= this.config.pendingMaxAgeMs;
        }
      }

      if (!reachedThreshold && !agedOut) {
        logger.debug(
          {
            pendingCount: pending.length,
            threshold: this.config.pendingThreshold,
            oldestAgeMin: Math.round(oldestAgeMs / 60_000),
            maxAgeMin: Math.round(this.config.pendingMaxAgeMs / 60_000),
          },
          'WrapupConsumer tick skipped: below threshold and not aged out',
        );
        return;
      }

      logger.info(
        {
          pendingCount: pending.length,
          triggerReason: reachedThreshold ? 'threshold' : 'aged_out',
          oldestAgeMin: Math.round(oldestAgeMs / 60_000),
        },
        'All conditions met, triggering pending wrapup consumer',
      );

      await this.executeWrapupConsume(pending.length);
    } catch (err) {
      logger.error({ err }, 'WrapupConsumer tick error');
    } finally {
      this.running = false;
      releaseMemoryWork('wrapup');
    }
  }

  /**
   * Detect Anthropic API 529 overload — CLI surfaces as stdout text with
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

  private async executeWrapupConsume(pendingBefore: number): Promise<void> {
    // Prompt body copied verbatim from aria-memory's SessionStart hook
    // (hooks/session-start.sh, the `## CRITICAL: Pending Memory Wrapups`
    // block). Keeping the wording identical means any future change to the
    // agent contract upstream — new required fields, renamed keys — can be
    // mirrored here with a single copy-paste, and we stay in sync with
    // what aria-memory's own hook has already been battle-tested on.
    //
    // One deviation: we drop the "BEFORE responding to the user's first
    // message" framing, which is meaningless in a headless `-p` invocation
    // where the prompt body *is* the user message.
    const memoryDir = `${homedir()}/.aria-memory`;
    const prompt = [
      '## CRITICAL: Pending Memory Wrapups',
      '',
      `There are ${pendingBefore} unprocessed session transcripts from previous sessions. You MUST call the memory-agent subagent to process them:`,
      '',
      `{"type":"session_wrapup","memoryDir":"${memoryDir}","processPending":true}`,
      '',
      'Process ALL pending entries, then return a brief summary (how many processed, any failures).',
    ].join('\n');

    // Exponential backoff for transient 529s — same schedule as sleep.
    const maxAttempts = 5;
    const baseDelayMs = 5_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Same two critical flags as GlobalSleepScheduler.executeGlobalSleep:
        //
        //   --permission-mode bypassPermissions
        //     Headless `-p` mode does not honor settings.json Write/Edit
        //     rules. Without bypass, the memory-agent reads fine but every
        //     Write/Edit gets denied and the run is a no-op.
        //
        //   --no-session-persistence
        //     Without this, the daemon-spawned session's own jsonl gets
        //     picked up by aria-memory's SessionEnd hook and registered as
        //     a new pendingWrapup — wrapup creates its own work, forever.
        //
        // See the longer explanation in memory-sleep.ts for the full story.
        const args = [
          '--no-session-persistence',
          '--permission-mode',
          'bypassPermissions',
          '-p',
          prompt,
          '--max-turns',
          '200',
          '--output-format',
          'text',
        ];
        const { stdout, stderr } = await execFileAsync('claude', args, {
          timeout: 1_800_000,
          cwd: homedir(),
          // The skill summary plus 12 wrapup line items can easily exceed
          // execFile's default 1 MB stdout buffer when there's a lot of
          // output. Bump to 10 MB so a chatty run isn't truncated and
          // misclassified as a failure.
          maxBuffer: 10 * 1024 * 1024,
        });

        if (stderr.trim()) {
          logger.warn(
            { stderr: stderr.trim().slice(0, 500) },
            'wrapup_consume stderr',
          );
        }

        // Verify via re-read: did pendingWrapups actually shrink?
        const afterMeta = JSON.parse(await readFile(META_PATH, 'utf-8'));
        const afterPending = (afterMeta.pendingWrapups ?? []).length;
        const consumed = afterPending < pendingBefore;

        if (consumed) {
          // Only a real, verified consumption advances the cooldown. Failed
          // runs leave lastRunAt untouched so the next tick retries.
          this.lastRunAt = Date.now();
          logger.info(
            {
              attempt,
              stdout: stdout.trim().slice(0, 500),
              pendingBefore,
              pendingAfter: afterPending,
              consumedCount: pendingBefore - afterPending,
            },
            'wrapup_consume completed',
          );
          return;
        }

        if (this.isOverloadedResponse(stdout) && attempt < maxAttempts) {
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
          logger.warn(
            {
              attempt,
              nextDelayMs: delayMs,
              stdout: stdout.trim().slice(0, 500),
            },
            'wrapup_consume hit Anthropic API 529 overloaded — retrying with exponential backoff',
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        logger.warn(
          {
            attempt,
            stdout: stdout.trim().slice(0, 500),
            pendingBefore,
            pendingAfter: afterPending,
          },
          'wrapup_consume ran but had no effect (pendingWrapups did not shrink) — leaving cooldown untouched so the next tick will retry',
        );
        return;
      } catch (err) {
        // Process-level failure (timeout/SIGTERM/spawn error). Don't retry
        // in-process; surface and let the next scheduler tick handle it.
        logger.error({ err, attempt }, 'wrapup_consume execution failed');
        return;
      }
    }
  }
}
