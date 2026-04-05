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
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './logger.js';
import { ARIA_MEMORY_DIR, META_PATH, withMetaLock } from './meta-lock.js';

const execAsync = promisify(exec);

export interface GlobalSleepConfig {
  /** Check interval in ms (default: 30min) */
  checkIntervalMs: number;
  /** Minimum time between global_sleep runs in ms (default: 6h) */
  cooldownMs: number;
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

    try {
      this.running = true;

      if (!existsSync(ARIA_MEMORY_DIR) || !existsSync(META_PATH)) {
        logger.debug('GlobalSleep tick skipped: aria-memory not found');
        return;
      }

      const meta = JSON.parse(await readFile(META_PATH, 'utf-8'));

      // Condition a: cooldown elapsed
      const lastSleep = meta.lastGlobalSleep
        ? new Date(meta.lastGlobalSleep).getTime()
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

      // Condition c: pending wrapups
      const pending: unknown[] = meta.pendingWrapups || [];
      if (pending.length === 0) {
        logger.debug('GlobalSleep tick skipped: no pending wrapups');
        return;
      }

      logger.info(
        { pendingCount: pending.length, lastSleepAge: `${Math.round(elapsed / 3_600_000)}h` },
        'All conditions met, triggering global_sleep',
      );

      await this.executeGlobalSleep();
    } catch (err) {
      logger.error({ err }, 'GlobalSleep tick error');
    } finally {
      this.running = false;
    }
  }

  private async executeGlobalSleep(): Promise<void> {
    try {
      const { stdout, stderr } = await execAsync(
        'claude -p "/memory-sleep" --max-turns 5 --output-format text',
        { timeout: 300_000 },
      );

      if (stdout.trim()) {
        logger.info({ stdout: stdout.trim().slice(0, 500) }, 'global_sleep completed');
      }
      if (stderr.trim()) {
        logger.warn({ stderr: stderr.trim().slice(0, 500) }, 'global_sleep stderr');
      }

      // Update lastGlobalSleep via shared mutex + atomic write.
      // Re-reads meta.json inside the lock so we don't clobber changes made by claude.
      await withMetaLock((meta) => {
        meta.lastGlobalSleep = new Date().toISOString();
        logger.info('Updated lastGlobalSleep timestamp in meta.json');
      });
    } catch (err) {
      logger.error({ err }, 'global_sleep execution failed');
    }
  }
}
