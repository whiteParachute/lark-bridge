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
import { ClaudeBridge, type StreamMessage } from './claude-bridge.js';
import { StreamingCardController } from './streaming-card.js';
import { ProgressCardController } from './progress-card.js';
import { type TranscriptEntry } from './memory-wrapup.js';
import { runHooks } from './hooks.js';
import { type FeishuClient, type FeishuMessage } from './feishu.js';
import { type BridgeConfig, reloadConfig } from './config.js';
import { logger } from './logger.js';
import * as lark from '@larksuiteoapi/node-sdk';

// ─── Types ───────────────────────────────────────────────────

type SessionState = 'starting' | 'active' | 'closing' | 'closed';

interface Session {
  chatId: string;
  chatType: 'p2p' | 'group';
  state: SessionState;
  claude: ClaudeBridge;
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
  private rateBuckets = new Map<string, RateBucket>();
  private config: BridgeConfig;
  private readonly feishu: FeishuClient;
  private readonly larkClient: lark.Client;
  private statusInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: BridgeConfig, feishu: FeishuClient) {
    this.config = config;
    this.feishu = feishu;
    this.larkClient = feishu.getLarkClient();

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
    // Hot-reload config so allowlist changes take effect without daemon restart
    const freshConfig = reloadConfig();
    if (freshConfig) {
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
      this.creatingChats.set(chatId, []);
      try {
        session = await this.createSession(chatId, msg.chatType);
        this.sessions.set(chatId, session);
        // Move messages that arrived during creation into session queue
        const arrived = this.creatingChats.get(chatId) || [];
        session.messageQueue.push(...arrived);
      } finally {
        this.creatingChats.delete(chatId);
      }
    }

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
    session.turnId = session.claude.getTurnId();
    // Create a promise that resolves when this turn completes
    session.turnCompletePromise = new Promise((resolve) => {
      session.turnCompleteResolve = resolve;
    });

    // Ack reaction: add "OnIt" emoji to user's message
    this.feishu.addReaction(msg.messageId, 'OnIt').then((reactionId) => {
      if (reactionId) {
        session.ackReaction = { messageId: msg.messageId, reactionId };
      }
    });

    // Push message to Claude
    try {
      session.claude.pushMessage(msg.text, msg.images);
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to push message to Claude');
      await this.feishu.sendMessage(chatId, '发送消息失败，请重试。');
    }
  }

  /**
   * Close a single session by chatId. Returns true if found and closed.
   * The next message from this chat will automatically create a fresh session.
   */
  async closeSessionByChatId(chatId: string, reason?: string): Promise<boolean> {
    const session = this.sessions.get(chatId);
    if (!session || session.state === 'closing' || session.state === 'closed') {
      return false;
    }
    if (session.streamingCard?.isActive()) {
      await session.streamingCard.abort(reason || '会话重置').catch(() => {});
    }
    if (session.progressCard.isActive()) {
      await session.progressCard.abort(reason || '会话重置').catch(() => {});
    }
    await this.closeSession(session, reason);
    return true;
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

  private async createSession(chatId: string, chatType: 'p2p' | 'group'): Promise<Session> {
    // Snapshot current config — this session uses it for its entire lifetime
    const sessionConfig = structuredClone(this.config);

    const workspaceDir = resolve(
      sessionConfig.claude.workspaceRoot,
      chatId.replace(/[^a-zA-Z0-9_-]/g, '_'),
    );
    if (!existsSync(workspaceDir)) {
      mkdirSync(workspaceDir, { recursive: true });
    }

    const claude = new ClaudeBridge();
    const progressCard = new ProgressCardController(this.larkClient, chatId);

    const session: Session = {
      chatId,
      chatType,
      state: 'starting',
      claude,
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
    };

    // Run session pre hooks (await before starting Claude)
    try {
      await runHooks(sessionConfig.hooks.session.pre, 'session.pre', {
        chatId,
        chatType,
        transcript: session.transcript,
      });
    } catch (err) {
      logger.error({ err, chatId }, 'Session pre hook failed');
    }

    // Start Claude session
    claude.start(
      {
        model: sessionConfig.claude.model,
        cwd: workspaceDir,
        additionalDirectories: sessionConfig.claude.additionalDirectories,
        permissionMode: sessionConfig.claude.permissionMode,
      },
      (msg) => this.handleStreamMessage(session, msg),
    );

    // Fix #8: max duration timer
    session.maxDurationTimer = setTimeout(() => {
      logger.info({ chatId }, 'Session max duration reached');
      this.closeSession(
        session,
        '会���已达最长时限，自动关闭。���送新消息可开���新对��。',
      ).catch((err) => {
        logger.error({ err, chatId }, 'Error closing max-duration session');
      });
    }, sessionConfig.session.maxDurationMs);

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
      await session.claude.interrupt();
    } catch (err) {
      logger.debug({ err, chatId: session.chatId }, 'interrupt() failed (best effort)');
    }

    try {
      session.claude.end();
      await Promise.race([
        session.claude.waitForCompletion(),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch (err) {
      logger.debug({ err, chatId: session.chatId }, 'end()/waitForCompletion() failed (best effort)');
    }

    // Clean up cards
    session.progressCard.dispose();
    session.streamingCard?.dispose();

    // Run session post hooks (includes aria-memory-wrapup by default)
    await runHooks(session.config.hooks.session.post, 'session.post', {
      chatId: session.chatId,
      chatType: session.chatType,
      sessionId: session.sessionId,
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
}
