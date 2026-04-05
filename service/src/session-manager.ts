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
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { ClaudeBridge, type StreamMessage } from './claude-bridge.js';
import { StreamingCardController } from './streaming-card.js';
import { ProgressCardController } from './progress-card.js';
import { type TranscriptEntry } from './memory-wrapup.js';
import { runHooks } from './hooks.js';
import { type FeishuClient, type FeishuMessage } from './feishu.js';
import { type BridgeConfig } from './config.js';
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
  turnId: number; // Tracks which turn the streaming card belongs to
  currentTurnId: number; // Monotonically increasing turn counter
}

// ─── Session Manager ─────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, Session>();
  private readonly config: BridgeConfig;
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

  async handleMessage(msg: FeishuMessage): Promise<void> {
    // ── Security: allowlist check ──
    if (!this.isAllowed(msg)) {
      logger.info(
        { chatId: msg.chatId, sender: msg.senderOpenId },
        'Message rejected: sender/chat not in allowlist',
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
      session = await this.createSession(chatId, msg.chatType);
      this.sessions.set(chatId, session);
    }

    session.lastActivityAt = Date.now();
    this.resetIdleTimer(session);

    // Record transcript
    session.transcript.push({
      role: 'user',
      content: msg.text,
      timestamp: new Date().toISOString(),
      imageCount: msg.images?.length,
    });

    // Run message pre hooks
    await runHooks(this.config.hooks.message.pre, 'message.pre', {
      chatId,
      chatType: session.chatType,
      role: 'user',
      content: msg.text,
      imageCount: msg.images?.length,
    });

    // ── Per-turn card management ──
    // Advance turn counter
    session.currentTurnId++;
    const thisTurnId = session.currentTurnId;

    // Abort existing streaming card if any (from previous turn)
    if (session.streamingCard?.isActive()) {
      await session.streamingCard.abort('新消息已到达');
    }

    // Abort previous progress card (it manages its own delete timer)
    if (session.progressCard.isActive()) {
      await session.progressCard.abort('新消息已到达');
    }
    session.progressCard = new ProgressCardController(this.larkClient, chatId);

    // Create new streaming card for THIS turn
    session.streamingCard = new StreamingCardController({
      client: this.larkClient,
      chatId,
      onFallback: () => {
        // Mark this card as failed — turn_complete handler will send plain text
        logger.info({ chatId }, 'Streaming card fallback triggered');
      },
    });
    session.turnId = thisTurnId;

    // Download files if any (Fix #6)
    if (msg.filePaths && msg.filePaths.length > 0) {
      const workspaceDir = resolve(
        this.config.claude.workspaceRoot,
        chatId.replace(/[^a-zA-Z0-9_-]/g, '_'),
      );
      const downloadDir = resolve(workspaceDir, 'downloads');
      mkdirSync(downloadDir, { recursive: true });

      for (const fp of msg.filePaths) {
        const [fileKey, filename] = fp.split(':', 2);
        if (fileKey && filename) {
          const savePath = resolve(downloadDir, filename);
          const result = await this.feishu.downloadFile(
            msg.messageId,
            fileKey,
            filename,
            savePath,
          );
          if (result) {
            // Append file path info to the message text
            msg.text += `\n[已下载文件: ${savePath}]`;
          }
        }
      }
    }

    // Push message to Claude
    try {
      session.claude.pushMessage(msg.text, msg.images);
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
    const workspaceDir = resolve(
      this.config.claude.workspaceRoot,
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
      currentTurnId: 0,
    };

    // Run session pre hooks (await before starting Claude)
    try {
      await runHooks(this.config.hooks.session.pre, 'session.pre', {
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
        model: this.config.claude.model,
        cwd: workspaceDir,
        additionalDirectories: this.config.claude.additionalDirectories,
        permissionMode: this.config.claude.permissionMode,
      },
      (msg) => this.handleStreamMessage(session, msg),
    );

    // Fix #8: max duration timer
    session.maxDurationTimer = setTimeout(() => {
      logger.info({ chatId }, 'Session max duration reached');
      this.closeSession(
        session,
        '会话已达最长时限，自动关闭。发送新消息可开启新对话。',
      ).catch((err) => {
        logger.error({ err, chatId }, 'Error closing max-duration session');
      });
    }, this.config.session.maxDurationMs);

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

        // Flush queued messages through the normal handleMessage path
        const queued = session.messageQueue.splice(0);
        for (const queuedMsg of queued) {
          this.handleMessage(queuedMsg).catch((err) => {
            logger.error({ err, chatId }, 'Error replaying queued message');
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
        if (session.streamingCard && session.turnId === session.currentTurnId) {
          session.streamingCard.append(msg.text || '');
        }
        break;

      case 'turn_complete': {
        const finalText = msg.text || '';

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
        if (card && session.turnId === session.currentTurnId) {
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
          runHooks(this.config.hooks.message.post, 'message.post', {
            chatId,
            chatType: session.chatType,
            role: 'assistant',
            content: finalText,
          }).catch((err) => {
            logger.error({ err, chatId }, 'Message post hook failed');
          });
        }

        // Create fresh progress card for next turn.
        // Old card manages its own delete timer via complete() — don't reset it.
        session.progressCard = new ProgressCardController(this.larkClient, chatId);
        break;
      }

      case 'error':
        logger.error({ chatId, error: msg.error }, 'Claude session error');
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
        '会话空闲超时，已自动关闭。发送新消息可开启新对话。',
      ).catch((err) => {
        logger.error(
          { err, chatId: session.chatId },
          'Error closing idle session',
        );
      });
    }, this.config.session.idleTimeoutMs);
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
    } catch {
      // Best effort
    }

    try {
      session.claude.end();
      await Promise.race([
        session.claude.waitForCompletion(),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch {
      // Best effort
    }

    // Clean up cards
    session.progressCard.dispose();
    session.streamingCard?.dispose();

    // Run session post hooks (includes aria-memory-wrapup by default)
    await runHooks(this.config.hooks.session.post, 'session.post', {
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
    } catch {
      // Non-critical
    }
  }
}
