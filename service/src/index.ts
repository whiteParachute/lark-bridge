/**
 * feishu-bridge — Bridge Feishu conversations to Claude Code sessions.
 *
 * Entry point: loads config, starts Feishu WebSocket, initializes session
 * manager, and wires up signal handlers for graceful shutdown.
 */
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { FeishuClient } from './feishu.js';
import { SessionManager } from './session-manager.js';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

async function main(): Promise<void> {
  logger.info('feishu-bridge starting...');

  // Load config
  const config = loadConfig();
  logger.info(
    {
      model: config.claude.model,
      workspace: config.claude.workspaceRoot,
      idleTimeout: `${config.session.idleTimeoutMs / 60_000}min`,
    },
    'Config loaded',
  );

  // Ensure directories exist
  const bridgeDir = resolve(homedir(), '.feishu-bridge');
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

  // Connect to Feishu
  await feishu.connect();
  logger.info('feishu-bridge ready. Listening for messages...');

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down...');

    try {
      await sessionManager.closeAll('服务维护中，会话已关闭。');
      await feishu.disconnect();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    }

    logger.info('feishu-bridge stopped.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  logger.fatal({ err }, 'feishu-bridge fatal error');
  process.exit(1);
});
