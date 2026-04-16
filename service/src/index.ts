/**
 * lark-bridge — Bridge Feishu conversations to Claude Code sessions.
 *
 * Entry point: loads config, starts Feishu WebSocket, initializes session
 * manager, and wires up signal handlers for graceful shutdown.
 */
import { loadConfig } from './config.js';
import { logger, initLogger } from './logger.js';
import { FeishuClient } from './feishu.js';
import { SessionManager } from './session-manager.js';
import { GlobalSleepScheduler } from './memory-sleep.js';
import { PendingWrapupConsumer } from './wrapup-consumer.js';
import { initMemoryPaths } from './meta-lock.js';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

async function main(): Promise<void> {
  logger.info('lark-bridge starting...');

  // Load config
  const config = loadConfig();
  initLogger(config.log.level);
  logger.info(
    {
      model: config.claude.model,
      workspace: config.claude.workspaceRoot,
      idleTimeout: `${config.session.idleTimeoutMs / 60_000}min`,
    },
    'Config loaded',
  );

  // Ensure directories exist
  const bridgeDir = resolve(homedir(), '.lark-bridge');
  if (!existsSync(bridgeDir)) mkdirSync(bridgeDir, { recursive: true });
  if (!existsSync(config.claude.workspaceRoot)) {
    mkdirSync(config.claude.workspaceRoot, { recursive: true });
  }

  // Initialize aria-memory paths (even when disabled — modules import
  // ARIA_MEMORY_DIR at module level, so it must be set before any tick)
  initMemoryPaths(config.ariaMemory.memoryDir);
  if (config.ariaMemory.enabled) {
    logger.info(
      {
        variant: config.ariaMemory.variant,
        memoryDir: config.ariaMemory.memoryDir,
      },
      'aria-memory integration enabled',
    );
  }

  // Initialize Feishu client
  let sessionManager: SessionManager;

  const feishu = new FeishuClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    onMessage: (msg) => {
      sessionManager.handleMessage(msg).catch((err) => {
        logger.error({ err, chatId: msg.chatId }, 'Error handling message');
      });
    },
    wsWatchdog: config.wsWatchdog,
  });

  // Initialize session manager
  sessionManager = new SessionManager(config, feishu);

  // Start memory maintenance schedulers.
  //
  // Two jobs coordinate via memory-maintenance.ts shared flag:
  //   - PendingWrapupConsumer: runs every 30min (check interval), fires
  //     when pending >= threshold and cooldown > 1h. Takes priority.
  //   - GlobalSleepScheduler: runs every 30min (check interval), fires
  //     when cooldown > 6h and pending > 0 but *below* wrapup threshold.
  //     Sleep defers to wrapup so the queue drains before the heavier
  //     maintenance pass.
  let wrapupConsumer: PendingWrapupConsumer | null = null;
  if (config.wrapupConsumer.enabled) {
    wrapupConsumer = new PendingWrapupConsumer(
      {
        checkIntervalMs: config.wrapupConsumer.checkIntervalMs,
        cooldownMs: config.wrapupConsumer.cooldownMs,
        pendingThreshold: config.wrapupConsumer.pendingThreshold,
        pendingMaxAgeMs: config.wrapupConsumer.pendingMaxAgeMs,
      },
      () => sessionManager.hasActiveSessions(),
    );
    wrapupConsumer.start();
  }

  let sleepScheduler: GlobalSleepScheduler | null = null;
  if (config.globalSleep.enabled) {
    sleepScheduler = new GlobalSleepScheduler(
      {
        checkIntervalMs: config.globalSleep.checkIntervalMs,
        cooldownMs: config.globalSleep.cooldownMs,
        minNewImpressions: config.globalSleep.minNewImpressions,
        staleAfterMs: config.globalSleep.staleAfterMs,
        // Defer to wrapup when pending is at/above wrapup's threshold. If
        // wrapup is disabled, deferToWrapupAbove stays undefined and sleep
        // behaves exactly as before.
        deferToWrapupAbove: config.wrapupConsumer.enabled
          ? config.wrapupConsumer.pendingThreshold
          : undefined,
      },
      () => sessionManager.hasActiveSessions(),
    );
    sleepScheduler.start();
  }

  // Connect to Feishu
  await feishu.connect();
  logger.info('lark-bridge ready. Listening for messages...');

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down...');

    try {
      wrapupConsumer?.stop();
      sleepScheduler?.stop();
      await sessionManager.closeAll('服务维护中，会话已关闭。');
      await feishu.disconnect();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    }

    logger.info('lark-bridge stopped.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  logger.fatal({ err }, 'lark-bridge fatal error');
  process.exit(1);
});
