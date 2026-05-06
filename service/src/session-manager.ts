/**
 * Session Manager — maps Feishu channels to Claude sessions.
 *
 * Fixes from review:
 * - #1: Sender/chat allowlist check
 * - #3: Fallback to plain text when streaming card fails
 * - #4: Per-turn streaming card tracking (no cross-turn contamination)
 * - #5: interrupt() + end() on session close
 * - #6: File download bridging
 * - #8: maxDurationMs enforcement
 * - NEW: Progress card for reasoning/tool progress (deleted after 15s)
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  type Backend,
  type BackendKind,
  type StreamMessage,
  createBackend,
} from './backend/index.js';
import { StreamingCardController } from './streaming-card.js';
import { ProgressCardController } from './progress-card.js';
import { type TranscriptEntry } from './memory-wrapup.js';
import { runHooks } from './hooks.js';
import { type FeishuClient, type FeishuMessage } from './feishu.js';
import { type BridgeConfig, reloadConfig } from './config.js';
import { type BotCommand, parseCommand } from './commands.js';
import { ChatStateStore } from './chat-state.js';
import { emitReloadWarningsIfWidened } from './allowlist-warnings.js';
import { logger } from './logger.js';
import * as lark from '@larksuiteoapi/node-sdk';

// ─── Types ───────────────────────────────────────────────────

type SessionState = 'starting' | 'active' | 'closing' | 'closed';

interface Session {
  chatId: string;
  chatType: 'p2p' | 'group';
  state: SessionState;
  backend: Backend;
  backendKind: BackendKind;
  /** 后端实际使用的工作目录（per-chat workspace） —— wrapup hook 用它解析 transcript 路径 */
  cwd: string;
  streamingCard: StreamingCardController | null;
  progressCard: ProgressCardController;
  transcript: TranscriptEntry[];
  createdAt: number;
  lastActivityAt: number;
  sessionId?: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  maxDurationTimer: ReturnType<typeof setTimeout> | null;
  messageQueue: FeishuMessage[];
  turnId: number; // Bridge turnId that the current streaming card belongs to
  /** Config snapshot captured at session creation — immune to later hot-reloads. */
  config: BridgeConfig;
  /** Ack reaction on user's message: messageId → reactionId */
  ackReaction: { messageId: string; reactionId: string } | null;
  /** Resolves when the current turn completes — used to sequence card ownership */
  turnCompleteResolve: (() => void) | null;
  turnCompletePromise: Promise<void> | null;
  /** `/hold` 已应用：idle/max timer 进入暂停态，直到会话被销毁 */
  held: boolean;
}

// ─── Session Manager ─────────────────────────────────────────

// ─── Rate Limiter (per-chat token bucket) ───────────────────

const RATE_LIMIT_MAX_TOKENS = 5;
const RATE_LIMIT_REFILL_MS = 60_000; // 1 token per 12s → 5 tokens/min

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

// ─── Session Manager ─────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, Session>();
  private creatingChats = new Map<string, FeishuMessage[]>(); // Messages arriving during createSession
  /**
   * 正在创建中的 session 的 Promise。`commandResetSession` 用它在切换后端前
   * 等待 in-flight 创建完成 —— 否则 inline prompt 会被发到旧后端的会话上。
   */
  private creatingPromises = new Map<string, Promise<Session>>();
  private rateBuckets = new Map<string, RateBucket>();
  private config: BridgeConfig;
  private readonly feishu: FeishuClient;
  private readonly larkClient: lark.Client;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private readonly chatState = new ChatStateStore();

  constructor(config: BridgeConfig, feishu: FeishuClient) {
    this.config = config;
    this.feishu = feishu;
    this.larkClient = feishu.getLarkClient();

    this.chatState.load();
    this.statusInterval = setInterval(() => this.writeStatus(), 10_000);
    this.writeStatus();
  }

  /** Returns true if there are any active or starting sessions. */
  hasActiveSessions(): boolean {
    for (const s of this.sessions.values()) {
      if (s.state === 'starting' || s.state === 'active') return true;
    }
    return false;
  }

  async handleMessage(msg: FeishuMessage): Promise<void> {
    // Hot-reload config so allowlist changes take effect without daemon restart.
    // 比较新旧 allowlist：变得更危险（允许更多人/群）就 warn 到日志——给运维一条
    // 面包屑，能看出何时白名单被外部改宽（手动 / 误操作 / 被 agent 自我改写）。
    const freshConfig = reloadConfig();
    if (freshConfig) {
      emitReloadWarningsIfWidened(this.config.feishu, freshConfig.feishu);
      this.config = freshConfig;
    }

    // ── Security: allowlist check ──
    if (!this.isAllowed(msg)) {
      logger.info(
        { chatId: msg.chatId, sender: msg.senderOpenId },
        'Message rejected: sender/chat not in allowlist',
      );
      return;
    }

    // ── Rate limiting (per-chat) ──
    if (!this.consumeRateToken(msg.chatId)) {
      logger.warn({ chatId: msg.chatId }, 'Rate limit exceeded');
      await this.feishu.sendMessage(
        msg.chatId,
        '⚠️ 消息频率过高，请稍后再试。',
      );
      return;
    }

    // ── Bot 命令分流 ──
    // 命中白名单（/new、/provider、/hold、/state）则在 bridge 内处理；
    // 其他 `/xxx`（包括 Claude Code 自身的 slash command）原样进后端。
    const command = parseCommand(msg.text);
    if (command) {
      await this.handleCommand(msg, command).catch((err) => {
        logger.error({ err, chatId: msg.chatId, command }, 'Command dispatch failed');
        this.feishu
          .sendMessage(msg.chatId, '⚠️ 命令处理失败，请稍后重试。')
          .catch(() => {});
      });
      return;
    }

    const { chatId } = msg;
    let session = this.sessions.get(chatId);

    if (session) {
      if (session.state === 'closing' || session.state === 'closed') {
        this.sessions.delete(chatId);
        session = undefined;
      } else if (session.state === 'starting') {
        session.messageQueue.push(msg);
        session.lastActivityAt = Date.now();
        this.resetIdleTimer(session);
        return;
      }
    }

    if (!session) {
      // Guard against concurrent createSession for the same chatId
      const pendingQueue = this.creatingChats.get(chatId);
      if (pendingQueue) {
        pendingQueue.push(msg);
        return;
      }
      // 默认后端来源优先级：chat-state 持久值 > config.defaultBackend
      const backendKind =
        this.chatState.getBackend(chatId) ?? this.config.defaultBackend;
      session = await this.startCreate(chatId, msg.chatType, backendKind);
    }

    await this.deliverUserMessage(session, msg);
  }

  /**
   * 创建会话的统一入口 —— 在 `creatingChats` 队列管理之外，还把 in-flight
   * Promise 登记到 `creatingPromises`，供 `commandResetSession` 在 `/provider`
   * 切换前等它完成。
   */
  private startCreate(
    chatId: string,
    chatType: 'p2p' | 'group',
    backendKind: BackendKind,
  ): Promise<Session> {
    this.creatingChats.set(chatId, []);
    const promise = (async () => {
      try {
        const session = await this.createSession(chatId, chatType, backendKind);
        this.sessions.set(chatId, session);
        // Move messages that arrived during creation into session queue
        const arrived = this.creatingChats.get(chatId) || [];
        session.messageQueue.push(...arrived);
        return session;
      } finally {
        this.creatingChats.delete(chatId);
        this.creatingPromises.delete(chatId);
      }
    })();
    this.creatingPromises.set(chatId, promise);
    return promise;
  }

  /**
   * 把一条已经过 allowlist + rate-limit + 命令解析的用户消息真正投递给后端：
   * 文件下载 → transcript 记账 → message.pre hooks → per-turn 卡片切换 →
   * ack reaction → backend.pushMessage。
   *
   * 公共路径，handleMessage 与 commandResetSession 的 inline-prompt 路径都用它。
   * 入口的"权限/限流/命令分流"由调用方负责，这里不再重复。
   */
  private async deliverUserMessage(
    session: Session,
    msg: FeishuMessage,
  ): Promise<void> {
    const { chatId } = session;
    session.lastActivityAt = Date.now();
    this.resetIdleTimer(session);

    // Download files first so transcript and hooks see the final message text
    if (msg.filePaths && msg.filePaths.length > 0) {
      const workspaceDir = resolve(
        session.config.claude.workspaceRoot,
        chatId.replace(/[^a-zA-Z0-9_-]/g, '_'),
      );
      const downloadDir = resolve(workspaceDir, 'downloads');
      mkdirSync(downloadDir, { recursive: true });

      for (const fp of msg.filePaths) {
        const colonIdx = fp.indexOf(':');
        if (colonIdx < 0) continue;
        const fileKey = fp.slice(0, colonIdx);
        const rawFilename = fp.slice(colonIdx + 1);
        if (fileKey && rawFilename) {
          // Sanitize filename to prevent path traversal
          const safeFilename = basename(rawFilename);
          if (!safeFilename) continue;
          const savePath = resolve(downloadDir, safeFilename);
          // Verify resolved path stays inside downloadDir
          if (!savePath.startsWith(downloadDir)) continue;
          const result = await this.feishu.downloadFile(
            msg.messageId,
            fileKey,
            safeFilename,
            savePath,
          );
          if (result) {
            msg.text += `\n[已下载文件: ${savePath}]`;
          }
        }
      }
    }

    // Record transcript (after file download so content is complete)
    session.transcript.push({
      role: 'user',
      content: msg.text,
      timestamp: new Date().toISOString(),
      imageCount: msg.images?.length,
    });

    // Run message pre hooks (sees final message including file paths)
    await runHooks(session.config.hooks.message.pre, 'message.pre', {
      chatId,
      chatType: session.chatType,
      role: 'user',
      content: msg.text,
      imageCount: msg.images?.length,
    });

    // ── Per-turn card management ──
    // Wait for the previous turn to complete before taking card ownership,
    // so turn_complete events are correctly attributed to the right card.
    if (session.turnCompletePromise) {
      await Promise.race([
        session.turnCompletePromise,
        new Promise((r) => setTimeout(r, 30_000)), // safety timeout
      ]);
    }

    if (session.streamingCard?.isActive()) {
      await session.streamingCard.abort('新消息已到达');
    }
    if (session.progressCard.isActive()) {
      await session.progressCard.abort('新消息已到达');
    }
    session.progressCard = new ProgressCardController(this.larkClient, chatId);

    session.streamingCard = new StreamingCardController({
      client: this.larkClient,
      chatId,
      onFallback: () => {
        logger.info({ chatId }, 'Streaming card fallback triggered');
        const text = session.streamingCard?.getAccumulatedText();
        if (text) {
          this.feishu.sendMessage(chatId, text).catch(() => {});
        }
      },
    });
    // Track which bridge turnId this card belongs to (now safe — previous turn is done)
    session.turnId = session.backend.getTurnId();
    // Create a promise that resolves when this turn completes
    session.turnCompletePromise = new Promise((resolve) => {
      session.turnCompleteResolve = resolve;
    });

    // Ack reaction: add "OnIt" emoji to user's message
    if (msg.messageId) {
      this.feishu.addReaction(msg.messageId, 'OnIt').then((reactionId) => {
        if (reactionId) {
          session.ackReaction = { messageId: msg.messageId, reactionId };
        }
      });
    }

    // Push message to backend
    try {
      session.backend.pushMessage(msg.text, msg.images);
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to push message to Claude');
      await this.feishu.sendMessage(chatId, '发送消息失败，请重试。');
    }
  }

  async closeAll(reason = '服务维护中'): Promise<void> {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    // Close sequentially to avoid meta.json write race (Fix #7)
    for (const session of this.sessions.values()) {
      if (session.streamingCard?.isActive()) {
        await session.streamingCard.abort(reason).catch(() => {});
      }
      if (session.progressCard.isActive()) {
        await session.progressCard.abort(reason).catch(() => {});
      }
      await this.closeSession(session, reason);
    }
  }

  // ─── Internal ──────────────────────────────────────────

  private consumeRateToken(chatId: string): boolean {
    const now = Date.now();
    let bucket = this.rateBuckets.get(chatId);
    if (!bucket) {
      bucket = { tokens: RATE_LIMIT_MAX_TOKENS, lastRefill: now };
      this.rateBuckets.set(chatId, bucket);
    }
    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const refill = Math.floor(elapsed / (RATE_LIMIT_REFILL_MS / RATE_LIMIT_MAX_TOKENS));
    if (refill > 0) {
      bucket.tokens = Math.min(RATE_LIMIT_MAX_TOKENS, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
    if (bucket.tokens > 0) {
      bucket.tokens--;
      return true;
    }
    return false;
  }

  private isAllowed(msg: FeishuMessage): boolean {
    const { allowedSenders, allowedChats } = this.config.feishu;
    // If both lists are empty, allow all (with warning at startup)
    if (allowedSenders.length === 0 && allowedChats.length === 0) return true;
    // Check sender
    if (allowedSenders.length > 0 && allowedSenders.includes(msg.senderOpenId))
      return true;
    // Check chat
    if (allowedChats.length > 0 && allowedChats.includes(msg.chatId))
      return true;
    return false;
  }

  private async createSession(
    chatId: string,
    chatType: 'p2p' | 'group',
    backendKind: BackendKind = 'claude',
  ): Promise<Session> {
    // Snapshot current config — this session uses it for its entire lifetime
    const sessionConfig = structuredClone(this.config);

    const workspaceDir = resolve(
      sessionConfig.claude.workspaceRoot,
      chatId.replace(/[^a-zA-Z0-9_-]/g, '_'),
    );
    if (!existsSync(workspaceDir)) {
      mkdirSync(workspaceDir, { recursive: true });
    }

    const backend = createBackend(backendKind);
    const progressCard = new ProgressCardController(this.larkClient, chatId);

    const session: Session = {
      chatId,
      chatType,
      state: 'starting',
      backend,
      backendKind,
      cwd: workspaceDir,
      streamingCard: null,
      progressCard,
      transcript: [],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimer: null,
      maxDurationTimer: null,
      messageQueue: [],
      turnId: 0,
      config: sessionConfig,
      ackReaction: null,
      turnCompleteResolve: null,
      turnCompletePromise: null,
      held: false,
    };

    // Run session pre hooks (await before starting backend)
    try {
      await runHooks(sessionConfig.hooks.session.pre, 'session.pre', {
        chatId,
        chatType,
        backendKind,
        cwd: workspaceDir,
        transcript: session.transcript,
      });
    } catch (err) {
      logger.error({ err, chatId }, 'Session pre hook failed');
    }

    // Start backend session — backend-specific options pulled from per-backend config blocks.
    //
    // additionalDirectories：用户配置的 + aria-memory vault（若 vault 目录存在
    // **且** 用户在 hooks.session.post 显式启用了 aria-memory-wrapup hook）。
    // hook 是 opt-in 信号，没启用就不该把 vault 加入 sandbox 白名单 —— 与
    // memory-wrapup 自身的 opt-in 模型保持一致。
    // 检测放在 createSession 而非 config 加载时，使得后续安装 aria-memory 或
    // 修改 hooks 的用户重启 daemon 后能立刻拿到正确权限。
    const additionalDirectories = [...sessionConfig.claude.additionalDirectories];
    const wrapupHookConfigured = sessionConfig.hooks.session.post.some(
      (h) => h.type === 'aria-memory-wrapup',
    );
    const ariaDir = sessionConfig.ariaMemory.memoryDir;
    if (
      wrapupHookConfigured &&
      ariaDir &&
      existsSync(ariaDir) &&
      !additionalDirectories.includes(ariaDir)
    ) {
      additionalDirectories.push(ariaDir);
    }

    const startOpts =
      backendKind === 'codex'
        ? {
            cwd: workspaceDir,
            additionalDirectories,
            ...(sessionConfig.codex.model ? { model: sessionConfig.codex.model } : {}),
          }
        : {
            cwd: workspaceDir,
            additionalDirectories,
            model: sessionConfig.claude.model,
            permissionMode: sessionConfig.claude.permissionMode,
          };
    backend.start(startOpts, (msg) => this.handleStreamMessage(session, msg));

    // Fix #8: max duration timer (skip if session is already held)
    if (!session.held) {
      session.maxDurationTimer = setTimeout(() => {
        logger.info({ chatId }, 'Session max duration reached');
        this.closeSession(
          session,
          '会���已达最长时限，自动关闭。���送新消息可开���新对��。',
        ).catch((err) => {
          logger.error({ err, chatId }, 'Error closing max-duration session');
        });
      }, sessionConfig.session.maxDurationMs);
    }

    logger.info({ chatId, chatType, workspaceDir }, 'Session created');
    return session;
  }

  private handleStreamMessage(session: Session, msg: StreamMessage): void {
    const { chatId } = session;

    switch (msg.type) {
      case 'session_init':
        session.sessionId = msg.sessionId;
        session.state = 'active';
        logger.info(
          { chatId, sessionId: msg.sessionId },
          'Claude session initialized',
        );

        // Flush queued messages: merge into a single message to avoid card churn
        const queued = session.messageQueue.splice(0);
        if (queued.length > 0) {
          const mergedText = queued.map((m) => m.text).join('\n---\n');
          const mergedImages = queued.flatMap((m) => m.images ?? []);
          const mergedFilePaths = queued.flatMap((m) => m.filePaths ?? []);
          // Use the last message as the base (for chatId, chatType, etc.)
          const merged: FeishuMessage = {
            ...queued[queued.length - 1],
            text: mergedText,
            images: mergedImages.length > 0 ? mergedImages : undefined,
            filePaths: mergedFilePaths.length > 0 ? mergedFilePaths : undefined,
          };
          this.handleMessage(merged).catch((err) => {
            logger.error({ err, chatId }, 'Error replaying merged queued messages');
          });
        }
        break;

      case 'thinking_delta':
        // Feed to progress card (not streaming card)
        session.progressCard.feedThinking(msg.text || '');
        break;

      case 'tool_use_start':
        session.progressCard.feedToolStart(msg.toolName || 'unknown');
        break;

      case 'tool_use_end':
        session.progressCard.feedToolEnd(msg.toolName || 'unknown');
        break;

      case 'text_delta':
        // Feed to streaming card (only if it belongs to the current turn)
        if (session.streamingCard && msg.turnId === session.turnId) {
          session.streamingCard.append(msg.text || '');
        }
        break;

      case 'turn_complete': {
        const finalText = msg.text || '';

        // Remove ack reaction from user's message
        if (session.ackReaction) {
          this.feishu.removeReaction(
            session.ackReaction.messageId,
            session.ackReaction.reactionId,
          );
          session.ackReaction = null;
        }

        // Record transcript
        if (finalText) {
          session.transcript.push({
            role: 'assistant',
            content: finalText,
            timestamp: new Date().toISOString(),
          });
        }

        // Complete progress card (will auto-delete after 15s)
        // Capture ref before reset — complete() manages its own lifecycle
        const progressCard = session.progressCard;
        progressCard.complete().catch(() => {});

        // Complete streaming card or fallback to plain message
        const card = session.streamingCard;
        if (card && msg.turnId === session.turnId) {
          card.complete(finalText).catch(() => {
            // Fix #3: Fallback — send as plain text when card fails
            if (finalText) {
              this.feishu.sendMessage(chatId, finalText).catch(() => {});
            }
          });
          session.streamingCard = null;
        } else if (finalText) {
          // No active card — send as plain message
          this.feishu.sendMessage(chatId, finalText).catch(() => {});
        }

        // If error result, notify user
        if (msg.isError && msg.error) {
          this.feishu
            .sendMessage(chatId, `⚠️ 执行出错: ${msg.error.slice(0, 200)}`)
            .catch(() => {});
        }

        // Run message post hooks
        if (finalText) {
          runHooks(session.config.hooks.message.post, 'message.post', {
            chatId,
            chatType: session.chatType,
            role: 'assistant',
            content: finalText,
          }).catch((err) => {
            logger.error({ err, chatId }, 'Message post hook failed');
          });
        }

        // Signal turn completion so next message can safely take card ownership
        if (session.turnCompleteResolve) {
          session.turnCompleteResolve();
          session.turnCompleteResolve = null;
          session.turnCompletePromise = null;
        }

        // Create fresh progress card for next turn.
        // Old card manages its own delete timer via complete() — don't reset it.
        session.progressCard = new ProgressCardController(this.larkClient, chatId);
        break;
      }

      case 'error':
        logger.error({ chatId, error: msg.error }, 'Claude session error');
        // Signal turn completion on error too
        if (session.turnCompleteResolve) {
          session.turnCompleteResolve();
          session.turnCompleteResolve = null;
          session.turnCompletePromise = null;
        }
        if (session.streamingCard?.isActive()) {
          session.streamingCard.abort(`错误: ${msg.error}`).catch(() => {});
          session.streamingCard = null;
        }
        session.progressCard.abort('会话出错').catch(() => {});
        this.feishu
          .sendMessage(chatId, `⚠️ 会话出错: ${msg.error?.slice(0, 200)}`)
          .catch(() => {});
        this.closeSession(session, undefined).catch(() => {});
        break;
    }
  }

  private resetIdleTimer(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    // /hold 已应用：idle timer 不再启动，会话保持直到被销毁
    if (session.held) return;

    session.idleTimer = setTimeout(() => {
      logger.info({ chatId: session.chatId }, 'Session idle timeout');
      this.closeSession(
        session,
        '会话空闲超时，已自动关��。发送���消息可开启新对话。',
      ).catch((err) => {
        logger.error(
          { err, chatId: session.chatId },
          'Error closing idle session',
        );
      });
    }, session.config.session.idleTimeoutMs);
  }

  private async closeSession(
    session: Session,
    reason?: string,
  ): Promise<void> {
    if (session.state === 'closing' || session.state === 'closed') return;
    session.state = 'closing';

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.maxDurationTimer) {
      clearTimeout(session.maxDurationTimer);
      session.maxDurationTimer = null;
    }

    // Fix #5: interrupt first, then end
    try {
      await session.backend.interrupt();
    } catch (err) {
      logger.debug({ err, chatId: session.chatId }, 'interrupt() failed (best effort)');
    }

    try {
      session.backend.end();
      await Promise.race([
        session.backend.waitForCompletion(),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch (err) {
      logger.debug({ err, chatId: session.chatId }, 'end()/waitForCompletion() failed (best effort)');
    }

    // Clean up cards
    session.progressCard.dispose();
    session.streamingCard?.dispose();

    // Run session post hooks. aria-memory-wrapup hook reads backendKind + cwd
    // + sessionId to resolve the real SDK transcript path.
    await runHooks(session.config.hooks.session.post, 'session.post', {
      chatId: session.chatId,
      chatType: session.chatType,
      sessionId: session.sessionId,
      backendKind: session.backendKind,
      cwd: session.cwd,
      transcript: session.transcript,
      reason,
    });

    if (reason) {
      await this.feishu.sendMessage(session.chatId, reason).catch(() => {});
    }

    session.state = 'closed';
    this.sessions.delete(session.chatId);
    logger.info({ chatId: session.chatId }, 'Session closed');
  }

  private writeStatus(): void {
    const statusPath = resolve(homedir(), '.lark-bridge', 'status.json');
    const sessions = [...this.sessions.values()].map((s) => ({
      chatId: s.chatId,
      chatType: s.chatType,
      state: s.state,
      backend: s.backendKind,
      held: s.held,
      messageCount: s.transcript.length,
      createdAt: new Date(s.createdAt).toISOString(),
      lastActivity: new Date(s.lastActivityAt).toISOString(),
      durationMin: Math.round((Date.now() - s.createdAt) / 60_000),
    }));

    try {
      writeFileSync(
        statusPath,
        JSON.stringify(
          {
            activeSessions: sessions.length,
            sessions,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch (err) {
      logger.debug({ err }, 'Failed to write status.json');
    }
  }

  // ─── Bot 命令 ──────────────────────────────────────────

  private async handleCommand(msg: FeishuMessage, cmd: BotCommand): Promise<void> {
    const { chatId } = msg;
    logger.info({ chatId, cmdType: cmd.type }, 'Bot command received');

    switch (cmd.type) {
      case 'invalid':
        await this.feishu.sendMessage(chatId, `⚠️ ${cmd.reason}`);
        return;

      case 'state':
        await this.commandState(chatId);
        return;

      case 'hold':
        await this.commandHold(chatId);
        return;

      case 'new': {
        const backendKind =
          this.chatState.getBackend(chatId) ?? this.config.defaultBackend;
        await this.commandResetSession(msg, backendKind, cmd.prompt, false);
        return;
      }

      case 'provider': {
        await this.commandResetSession(msg, cmd.backend, cmd.prompt, true);
        return;
      }
    }
  }

  /**
   * 公共路径：关闭当前会话 → 用指定 backend 起新会话 → 可选首条消息。
   *
   * `persistBackend` 控制是否把 backend 选择写到 chat-state.json。
   * `/new` 走当前默认 backend，不写；`/provider X` 切换默认 backend，写入。
   */
  private async commandResetSession(
    msg: FeishuMessage,
    backendKind: BackendKind,
    inlinePrompt: string | undefined,
    persistBackend: boolean,
  ): Promise<void> {
    const { chatId } = msg;

    // #2 race fix: 如果有 in-flight 的 createSession 正在跑（比如用户上一条
    // 普通消息正在触发创建），先等它跑完。否则我们关闭"还没存在的 session"
    // 是 no-op，等创建完之后那个旧 backend 的 session 反而还在，inline prompt
    // 会被发到旧后端去。
    const inflight = this.creatingPromises.get(chatId);
    if (inflight) {
      await inflight.catch(() => {
        /* 创建本身失败也只是不存在 session，继续走关闭 + 新建即可 */
      });
    }

    if (persistBackend) {
      this.chatState.setBackend(chatId, backendKind);
    }

    // 关闭旧会话（如果有）
    const existing = this.sessions.get(chatId);
    if (existing && existing.state !== 'closed') {
      await this.closeSession(existing).catch((err) => {
        logger.error({ err, chatId }, 'Error closing session for /new or /provider');
      });
    }

    const ackPrefix = persistBackend
      ? `🔁 已切换到 ${backendKind} 后端。`
      : `🆕 已开启新会话（${backendKind}）。`;

    if (!inlinePrompt) {
      await this.feishu.sendMessage(
        chatId,
        `${ackPrefix}发送下条消息开始新对话。`,
      );
      return;
    }

    // 有 inline prompt：起新 session（指定 backend）+ 走公共投递路径。
    // 公共路径会跑 message.pre hooks、做 ack reaction、文件桥接，与普通
    // 消息完全一致 —— 但不再过 allowlist / rate-limit / 命令解析（已在
    // handleMessage 入口处消耗过）。
    await this.feishu.sendMessage(chatId, ackPrefix);

    const session = await this.startCreate(chatId, msg.chatType, backendKind);
    const continuationMsg: FeishuMessage = {
      ...msg,
      text: inlinePrompt,
    };
    await this.deliverUserMessage(session, continuationMsg);
  }

  private async commandHold(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) {
      await this.feishu.sendMessage(chatId, '当前没有活跃会话。');
      return;
    }
    if (session.held) {
      await this.feishu.sendMessage(
        chatId,
        '✋ 当前会话已处于保持状态。',
      );
      return;
    }
    session.held = true;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.maxDurationTimer) {
      clearTimeout(session.maxDurationTimer);
      session.maxDurationTimer = null;
    }
    logger.info({ chatId }, 'Session held — idle/max timers suspended');
    await this.feishu.sendMessage(
      chatId,
      '✋ 会话已保持，将不会被空闲或最长时限自动关闭。下次 `/new` 或 `/provider` 可解除。',
    );
  }

  private async commandState(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) {
      const persistedBackend = this.chatState.getBackend(chatId);
      const backendStr = persistedBackend ? `（默认后端：${persistedBackend}）` : '';
      await this.feishu.sendMessage(
        chatId,
        `当前没有活跃会话。${backendStr}\n发送任意消息开启新会话。`,
      );
      return;
    }

    const now = Date.now();
    const ageMin = Math.round((now - session.createdAt) / 60_000);
    const idleMin = Math.round((now - session.lastActivityAt) / 60_000);
    const snap = session.progressCard.getSnapshot();

    const lines: string[] = [];
    lines.push(`**📊 会话状态**`);
    lines.push(`后端：\`${session.backendKind}\``);
    lines.push(`状态：${this.stateLabel(session)}`);

    if (snap.activeTools.length > 0) {
      lines.push(`正在执行：🔧 ${snap.activeTools.join(', ')}`);
    } else if (snap.thinking) {
      lines.push(`正在思考：${snap.thinking.slice(0, 100)}`);
    }

    lines.push(`消息数：${session.transcript.length}`);
    lines.push(`运行时长：${ageMin} 分钟`);
    lines.push(`最近活动：${idleMin} 分钟前`);

    if (session.held) {
      lines.push(`自动关闭：✋ 已保持`);
    } else {
      const idleTimeoutMin = Math.round(
        session.config.session.idleTimeoutMs / 60_000,
      );
      const remaining = Math.max(idleTimeoutMin - idleMin, 0);
      lines.push(`空闲关闭倒计时：${remaining} 分钟`);
    }

    await this.feishu.sendMessage(chatId, lines.join('\n'));
  }

  private stateLabel(session: Session): string {
    if (session.state === 'starting') return '⏳ 启动中';
    if (session.state === 'closing') return '🔚 关闭中';
    if (session.state === 'closed') return '⛔ 已关闭';
    if (session.streamingCard?.isActive() || session.progressCard.isActive()) {
      return '🔄 处理中';
    }
    return '💤 空闲';
  }
}
