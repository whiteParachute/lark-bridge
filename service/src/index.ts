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
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
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

  // ── Per-session control via SIGUSR1 + control file ──
  const controlFile = resolve(bridgeDir, 'control.json');
  process.on('SIGUSR1', () => {
    (async () => {
      try {
        const raw = readFileSync(controlFile, 'utf-8');
        unlinkSync(controlFile); // consume command immediately
        const cmd = JSON.parse(raw) as { action: string; chatId?: string; reason?: string };
        const reason = cmd.reason || '会话已重置，下条消息将使用最新配置。';

        if (cmd.action === 'close' && cmd.chatId) {
          const ok = await sessionManager.closeSessionByChatId(cmd.chatId, reason);
          logger.info({ chatId: cmd.chatId, found: ok }, 'Control: close session');
        } else if (cmd.action === 'close-all') {
          await sessionManager.closeAll(reason);
          logger.info('Control: close all sessions');
        } else {
          logger.warn({ cmd }, 'Control: unknown action');
        }
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          // No control file — treat SIGUSR1 as close-all (convenience shortcut)
          await sessionManager.closeAll('会话已重置，下条消息将使用最新配置。');
          logger.info('Control: SIGUSR1 without control file, closed all sessions');
        } else {
          logger.warn({ err }, 'Control: failed to process command');
        }
      }
    })().catch((err) => logger.error({ err }, 'Control handler error'));
  });

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  logger.fatal({ err }, 'lark-bridge fatal error');
  process.exit(1);
});
