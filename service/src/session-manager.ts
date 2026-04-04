/**
 * Session Manager — maps Feishu channels to Claude sessions.
 *
 * Core responsibilities:
 * - Create/reuse Claude sessions per chat_id
 * - Route messages to the correct session
 * - Manage idle timeout and session lifecycle
 * - Stream Claude output to Feishu streaming cards
 * - Export transcripts on session close
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { ClaudeBridge, type StreamMessage } from './claude-bridge.js';
import { StreamingCardController } from './streaming-card.js';
import { exportAndRegisterWrapup, type TranscriptEntry } from './memory-wrapup.js';
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
  transcript: TranscriptEntry[];
  createdAt: number;
  lastActivityAt: number;
  sessionId?: string; // Claude session ID for resume
  idleTimer: ReturnType<typeof setTimeout> | null;
  messageQueue: FeishuMessage[]; // Queue for messages during 'starting'
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

    // Periodically write status file
    this.statusInterval = setInterval(() => this.writeStatus(), 10_000);
    this.writeStatus();
  }

  /**
   * Handle an incoming Feishu message.
   */
  async handleMessage(msg: FeishuMessage): Promise<void> {
    const { chatId } = msg;
    let session = this.sessions.get(chatId);

    if (session) {
      if (session.state === 'closing' || session.state === 'closed') {
        // Session is ending, wait for it to finish then create new
        this.sessions.delete(chatId);
        session = undefined;
      } else if (session.state === 'starting') {
        // Queue message until session is ready
        session.messageQueue.push(msg);
        session.lastActivityAt = Date.now();
        this.resetIdleTimer(session);
        return;
      }
    }

    if (!session) {
      session = this.createSession(chatId, msg.chatType);
      this.sessions.set(chatId, session);
    }

    // Reset idle timer
    session.lastActivityAt = Date.now();
    this.resetIdleTimer(session);

    // Record in transcript
    session.transcript.push({
      role: 'user',
      content: msg.text,
      timestamp: new Date().toISOString(),
      imageCount: msg.images?.length,
    });

    // Abort existing streaming card if any
    if (session.streamingCard?.isActive()) {
      await session.streamingCard.abort('新消息已到达');
    }

    // Create new streaming card for this response
    session.streamingCard = new StreamingCardController({
      client: this.larkClient,
      chatId,
      onFallback: () => {
        // If streaming fails, the turn_complete handler will send a plain message
        logger.info({ chatId }, 'Streaming card fallback triggered');
      },
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
   * Gracefully close all sessions (for shutdown).
   */
  async closeAll(reason = '服务维护中'): Promise<void> {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    const promises = [...this.sessions.values()].map(async (session) => {
      if (session.streamingCard?.isActive()) {
        await session.streamingCard.abort(reason).catch(() => {});
      }
      await this.closeSession(session, reason);
    });
    await Promise.allSettled(promises);
  }

  // ─── Internal ──────────────────────────────────────────

  private createSession(chatId: string, chatType: 'p2p' | 'group'): Session {
    const workspaceDir = resolve(
      this.config.claude.workspaceRoot,
      chatId.replace(/[^a-zA-Z0-9_-]/g, '_'),
    );
    if (!existsSync(workspaceDir)) {
      mkdirSync(workspaceDir, { recursive: true });
    }

    const claude = new ClaudeBridge();
    const session: Session = {
      chatId,
      chatType,
      state: 'starting',
      claude,
      streamingCard: null,
      transcript: [],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimer: null,
      messageQueue: [],
    };

    // Start Claude session
    claude.start(
      {
        model: this.config.claude.model,
        cwd: workspaceDir,
        additionalDirectories: this.config.claude.additionalDirectories,
      },
      (msg) => this.handleStreamMessage(session, msg),
    );

    logger.info({ chatId, chatType, workspaceDir }, 'Session created');
    return session;
  }

  private handleStreamMessage(session: Session, msg: StreamMessage): void {
    const { chatId } = session;

    switch (msg.type) {
      case 'session_init':
        session.sessionId = msg.sessionId;
        session.state = 'active';
        logger.info({ chatId, sessionId: msg.sessionId }, 'Claude session initialized');

        // Flush queued messages
        while (session.messageQueue.length > 0) {
          const queued = session.messageQueue.shift()!;
          session.transcript.push({
            role: 'user',
            content: queued.text,
            timestamp: new Date().toISOString(),
            imageCount: queued.images?.length,
          });
          session.claude.pushMessage(queued.text, queued.images);
        }
        break;

      case 'text_delta':
        if (session.streamingCard) {
          session.streamingCard.append(msg.text || '');
        }
        break;

      case 'turn_complete': {
        const finalText = msg.text || '';

        // Record in transcript
        if (finalText) {
          session.transcript.push({
            role: 'assistant',
            content: finalText,
            timestamp: new Date().toISOString(),
          });
        }

        // Complete streaming card or send as plain message
        if (session.streamingCard) {
          session.streamingCard.complete(finalText).catch(() => {
            // If complete fails, send as plain message
            this.feishu.sendMessage(chatId, finalText).catch(() => {});
          });
          session.streamingCard = null;
        } else if (finalText) {
          this.feishu.sendMessage(chatId, finalText).catch(() => {});
        }
        break;
      }

      case 'error':
        logger.error({ chatId, error: msg.error }, 'Claude session error');
        if (session.streamingCard?.isActive()) {
          session.streamingCard.abort(`错误: ${msg.error}`).catch(() => {});
          session.streamingCard = null;
        }
        this.feishu
          .sendMessage(chatId, `⚠️ 会话出错: ${msg.error?.slice(0, 200)}`)
          .catch(() => {});
        // Close the session on error
        this.closeSession(session, '会话出错').catch(() => {});
        break;
    }
  }

  private resetIdleTimer(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);

    session.idleTimer = setTimeout(() => {
      logger.info({ chatId: session.chatId }, 'Session idle timeout');
      this.closeSession(session, '会话空闲超时，已自动关闭。发送新消息可开启新对话。').catch(
        (err) => {
          logger.error({ err, chatId: session.chatId }, 'Error closing idle session');
        },
      );
    }, this.config.session.idleTimeoutMs);
  }

  private async closeSession(session: Session, reason?: string): Promise<void> {
    if (session.state === 'closing' || session.state === 'closed') return;
    session.state = 'closing';

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    // End Claude session
    try {
      session.claude.end();
      // Give it a moment to clean up
      await Promise.race([
        session.claude.waitForCompletion(),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch {
      // Best effort
    }

    // Export transcript and register wrapup
    if (session.transcript.length > 0) {
      await exportAndRegisterWrapup(
        session.chatId,
        session.chatType,
        session.transcript,
      );
    }

    // Notify user
    if (reason) {
      await this.feishu.sendMessage(session.chatId, reason).catch(() => {});
    }

    session.state = 'closed';
    this.sessions.delete(session.chatId);
    logger.info({ chatId: session.chatId }, 'Session closed');
  }

  private writeStatus(): void {
    const statusPath = resolve(homedir(), '.feishu-bridge', 'status.json');
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
