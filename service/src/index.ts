/**
 * lark-bridge — Bridge Feishu conversations to Claude Code / Codex sessions.
 *
 * Entry point: loads config, starts Feishu WebSocket, initializes session
 * manager, and wires up signal handlers for graceful shutdown.
 *
 * 注：daemon 不再跑任何 aria-memory schedulers。wrapup / sleep 由 primary host
 * 的 claude/codex CLI 启动时的 aria-memory SessionStart hook 处理；lark-bridge
 * 这边只在会话关闭时把 transcript 路径登记到 meta.json.pendingWrapups。
 */
import { loadConfig } from './config.js';
import { logger, initLogger } from './logger.js';
import { FeishuClient } from './feishu.js';
import { SessionManager } from './session-manager.js';
import { initMemoryPaths } from './meta-lock.js';
import { emitStartupWarnings } from './allowlist-warnings.js';
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
      defaultBackend: config.defaultBackend,
      claudeModel: config.claude.model,
      codexModel: config.codex.model ?? '(SDK default)',
      workspace: config.claude.workspaceRoot,
      idleTimeout: `${config.session.idleTimeoutMs / 60_000}min`,
    },
    'Config loaded',
  );

  // YOLO 模式安全告警：两个后端实际都能跑任意命令（claude canUseTool 永远 allow，
  // codex sandbox=danger-full-access），所以宽松白名单等于把 host 当公开 shell。
  emitStartupWarnings(config.feishu);

  // Ensure directories exist
  const bridgeDir = resolve(homedir(), '.lark-bridge');
  if (!existsSync(bridgeDir)) mkdirSync(bridgeDir, { recursive: true });
  if (!existsSync(config.claude.workspaceRoot)) {
    mkdirSync(config.claude.workspaceRoot, { recursive: true });
  }

  // 初始化 aria-memory 路径常量。即使用户没装 aria-memory 也调用 ——
  // wrapup hook 内部用 existsSync 判断目录存在性，缺失时静默 skip。
  initMemoryPaths(config.ariaMemory.memoryDir);

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
