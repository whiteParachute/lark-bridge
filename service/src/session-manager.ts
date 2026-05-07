/**
 * Session Manager — maps Feishu channels to backend sessions.
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
  type BackendStartOptions,
  type BackendKind,
  type DirectBackendKind,
  type StreamMessage,
  type TmuxBackendOptions,
  createBackend,
} from './backend/index.js';
import {
  captureTmuxTarget,
  ensureTmuxTargetReady,
  isValidTmuxSessionName,
  killTmuxSession,
  listTmuxSessions,
  tmuxTargetExists,
} from './backend/tmux.js';
import { StreamingCardController } from './streaming-card.js';
import { ProgressCardController } from './progress-card.js';
import { type TranscriptEntry } from './memory-wrapup.js';
import { runHooks } from './hooks.js';
import { type FeishuClient, type FeishuMessage } from './feishu.js';
import { type BridgeConfig, reloadConfig } from './config.js';
import { type BotCommand, parseCommand } from './commands.js';
import { ChatStateStore, type ChatTmuxTarget } from './chat-state.js';
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
  /** 本 session 启动时实际传给后端的模型；undefined 表示使用 SDK/CLI 默认。 */
  model?: string;
  /** 本 session 启动时实际传给后端的推理强度。 */
  reasoningEffort?: string;
  tmuxTarget?: string;
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
  /** Serializes per-session delivery so queued Feishu messages cannot steal turn ownership. */
  deliveryChain: Promise<void>;
  /** `/hold` 已应用：idle/max timer 进入暂停态，直到会话被销毁 */
  held: boolean;
}

// ─── Session Manager ─────────────────────────────────────────

// ─── Rate Limiter (per-chat token bucket) ───────────────────

const RATE_LIMIT_MAX_TOKENS = 5;
const RATE_LIMIT_REFILL_MS = 60_000; // 1 token per 12s → 5 tokens/min
const MAX_TMUX_CAPTURE_LINES = 5_000;
const MAX_TMUX_CAPTURE_CHARS = 12_000;

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

  private isDirectBackend(backendKind: BackendKind): backendKind is DirectBackendKind {
    return backendKind === 'claude' || backendKind === 'codex';
  }

  private configModel(
    backendKind: DirectBackendKind,
    config: BridgeConfig,
  ): string | undefined {
    return backendKind === 'codex' ? config.codex.model : config.claude.model;
  }

  private configReasoningEffort(
    backendKind: DirectBackendKind,
    config: BridgeConfig,
  ): string | undefined {
    return backendKind === 'codex'
      ? config.codex.modelReasoningEffort
      : config.claude.effort;
  }

  private resolveModel(
    chatId: string,
    backendKind: DirectBackendKind,
    config: BridgeConfig,
  ): string | undefined {
    return (
      this.chatState.getModel(chatId, backendKind) ??
      this.configModel(backendKind, config)
    );
  }

  private modelLabel(model: string | undefined): string {
    if (!model) return 'SDK 默认模型';
    return '`' + model.replace(/`/g, "'") + '`';
  }

  private minutesFromMs(ms: number): number {
    return Math.max(0, Math.ceil(ms / 60_000));
  }

  private selectBackendKind(chatId: string): BackendKind {
    const persisted = this.chatState.getBackend(chatId);
    if (
      persisted === 'tmux' &&
      (!this.config.tmux.enabled || !this.chatState.getTmux(chatId))
    ) {
      return this.config.defaultBackend;
    }
    return persisted ?? this.config.defaultBackend;
  }

  private async selectBackendKindForStart(chatId: string): Promise<{
    backendKind: BackendKind;
    clearedTmuxTarget?: string;
  }> {
    const backendKind = this.selectBackendKind(chatId);
    if (backendKind !== 'tmux') return { backendKind };

    const target = this.chatState.getTmux(chatId);
    if (!this.config.tmux.enabled || !target) {
      return { backendKind: this.config.defaultBackend };
    }

    // `/tmux new` targets may legitimately be absent; createSession will create
    // them before acknowledging success. Attached targets must still exist.
    if (target.create && target.sessionName) return { backendKind };
    if (await tmuxTargetExists(target.target)) return { backendKind };

    this.chatState.clearTmux(chatId);
    return {
      backendKind: this.config.defaultBackend,
      clearedTmuxTarget: target.target,
    };
  }

  private workspaceDirFor(chatId: string, config: BridgeConfig = this.config): string {
    return resolve(
      config.claude.workspaceRoot,
      chatId.replace(/[^a-zA-Z0-9_-]/g, '_'),
    );
  }

  private expandUserPath(input: string | undefined, fallback: string): string {
    if (!input) return fallback;
    if (input === '~') return homedir();
    if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
    return resolve(input);
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
    // 命中白名单（/help、/new、/provider、/hold、/release、/state、/model、/tmux）
    // 则在 bridge 内处理；
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
      // 默认后端来源优先级：chat-state 持久值 > config.defaultBackend。
      // 如果持久值是 tmux，还需要有可用的 tmux target。
      const { backendKind, clearedTmuxTarget } =
        await this.selectBackendKindForStart(chatId);
      if (clearedTmuxTarget) {
        await this.feishu.sendMessage(
          chatId,
          `⚠️ tmux target \`${clearedTmuxTarget}\` 已不存在，已清除接管状态并改用 ${backendKind} 后端处理本条消息。`,
        );
      }
      try {
        session = await this.startCreate(chatId, msg.chatType, backendKind);
      } catch (err: any) {
        logger.error({ err, chatId, backendKind }, 'Session create failed');
        if (backendKind !== 'tmux') {
          await this.feishu.sendMessage(
            chatId,
            `⚠️ 会话启动失败: ${err?.message || String(err)}`,
          );
          return;
        }

        const failedTarget = this.chatState.getTmux(chatId)?.target;
        this.chatState.clearTmux(chatId);
        await this.feishu.sendMessage(
          chatId,
          `⚠️ tmux 接管启动失败${failedTarget ? `（${failedTarget}）` : ''}，已清除接管状态并改用 ${this.config.defaultBackend} 后端重试。错误：${err?.message || String(err)}`,
        );
        try {
          session = await this.startCreate(
            chatId,
            msg.chatType,
            this.config.defaultBackend,
          );
        } catch (fallbackErr: any) {
          logger.error(
            { err: fallbackErr, chatId },
            'Fallback session create failed after tmux failure',
          );
          await this.feishu.sendMessage(
            chatId,
            `⚠️ fallback 会话启动失败: ${fallbackErr?.message || String(fallbackErr)}`,
          );
          return;
        }
      }
    }

    await this.enqueueUserDelivery(session, msg);
  }

  private async enqueueUserDelivery(
    session: Session,
    msg: FeishuMessage,
  ): Promise<void> {
    const previous = session.deliveryChain.catch(() => {});
    const current = previous.then(async () => {
      if (this.isSessionClosingOrClosed(session)) return;
      await this.deliverUserMessage(session, msg);
    });
    session.deliveryChain = current.catch((err) => {
      logger.error({ err, chatId: session.chatId }, 'Queued message delivery failed');
    });
    await current;
  }

  private isSessionClosingOrClosed(session: Session): boolean {
    return session.state === 'closing' || session.state === 'closed';
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
   * 文件下载 → 等待上一轮完成 → transcript 记账 → message.pre hooks → per-turn 卡片切换 →
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
    if (this.isSessionClosingOrClosed(session)) return;

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

    // ── Per-turn card management ──
    // Wait for the previous turn to complete before taking card ownership,
    // so turn_complete events are correctly attributed to the right card.
    // tmux startup/attach observations are intentionally not bypassed by the
    // 30s safety timeout: a new prompt must not be pasted into a pane while the
    // previous CLI task is still visibly running.
    if (session.turnCompletePromise) {
      if (session.backendKind === 'tmux') {
        await this.feishu.sendMessage(
          chatId,
          'tmux pane 正在同步上一轮输出；本条消息会在输出稳定后发送到同一个 pane。',
        );
        await session.turnCompletePromise;
      } else {
        await Promise.race([
          session.turnCompletePromise,
          new Promise((r) => setTimeout(r, 30_000)), // safety timeout
        ]);
      }
    }
    if (this.isSessionClosingOrClosed(session)) return;

    // Record transcript (after file download and after this message is ready to send)
    session.transcript.push({
      role: 'user',
      content: msg.text,
      timestamp: new Date().toISOString(),
      imageCount: msg.images?.length,
    });

    // Run message pre hooks as close as possible to the actual backend push.
    await runHooks(session.config.hooks.message.pre, 'message.pre', {
      chatId,
      chatType: session.chatType,
      role: 'user',
      content: msg.text,
      imageCount: msg.images?.length,
    });
    if (this.isSessionClosingOrClosed(session)) return;

    if (session.streamingCard?.isActive()) {
      await session.streamingCard.abort('新消息已到达');
    }
    if (session.progressCard.isActive()) {
      await session.progressCard.abort('新消息已到达');
    }
    this.beginTurnCard(session);

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
      logger.error({ err, chatId }, 'Failed to push message to backend');
      this.resolveTurnCompletion(session);
      session.streamingCard?.abort('发送消息失败').catch(() => {});
      session.streamingCard = null;
      session.progressCard.abort('发送消息失败').catch(() => {});
      await this.feishu.sendMessage(chatId, '发送消息失败，请重试。');
    }
  }

  private beginTurnCard(session: Session): void {
    const { chatId } = session;
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
    session.turnId = session.backend.getTurnId();
    session.turnCompletePromise = new Promise((resolve) => {
      session.turnCompleteResolve = resolve;
    });
  }

  private resolveTurnCompletion(session: Session): void {
    if (session.turnCompleteResolve) {
      session.turnCompleteResolve();
    }
    session.turnCompleteResolve = null;
    session.turnCompletePromise = null;
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

    const workspaceDir = this.workspaceDirFor(chatId, sessionConfig);
    if (!existsSync(workspaceDir)) {
      mkdirSync(workspaceDir, { recursive: true });
    }

    const backend = createBackend(backendKind);
    const model = this.isDirectBackend(backendKind)
      ? this.resolveModel(chatId, backendKind, sessionConfig)
      : undefined;
    const reasoningEffort = this.isDirectBackend(backendKind)
      ? this.configReasoningEffort(backendKind, sessionConfig)
      : undefined;
    const tmuxTarget = backendKind === 'tmux' ? this.chatState.getTmux(chatId) : null;
    const progressCard = new ProgressCardController(this.larkClient, chatId);

    const session: Session = {
      chatId,
      chatType,
      state: 'starting',
      backend,
      backendKind,
      model,
      reasoningEffort,
      tmuxTarget: tmuxTarget?.target,
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
      deliveryChain: Promise.resolve(),
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

    const startOpts: BackendStartOptions =
      backendKind === 'codex'
        ? {
            cwd: workspaceDir,
            additionalDirectories,
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
          }
        : backendKind === 'claude'
          ? {
            cwd: workspaceDir,
            additionalDirectories,
            model: model ?? sessionConfig.claude.model,
            reasoningEffort,
            permissionMode: sessionConfig.claude.permissionMode,
          }
          : {
              cwd: workspaceDir,
              tmux: this.buildTmuxStartOptions(
                chatId,
                sessionConfig,
                workspaceDir,
                tmuxTarget,
                additionalDirectories,
              ),
            };
    if (backendKind === 'tmux' && startOpts.tmux) {
      await ensureTmuxTargetReady(startOpts.tmux);
      if (startOpts.tmux.observeOnStart) {
        this.beginTurnCard(session);
      }
    }
    backend.start(startOpts, (msg) => this.handleStreamMessage(session, msg));

    // Fix #8: max duration timer (skip if session is already held)
    if (!session.held) {
      this.armMaxDurationTimer(session, sessionConfig.session.maxDurationMs);
    }

    logger.info(
      {
        chatId,
        chatType,
        backendKind,
        workspaceDir,
        model,
        reasoningEffort,
        tmuxTarget,
      },
      'Session created',
    );
    return session;
  }

  private buildTmuxStartOptions(
    chatId: string,
    config: BridgeConfig,
    fallbackCwd: string,
    target: ChatTmuxTarget | null,
    additionalDirectories: string[],
  ): TmuxBackendOptions {
    if (!config.tmux.enabled) {
      throw new Error('tmux backend is disabled by config');
    }
    if (!target) {
      throw new Error(`chat ${chatId} has no tmux target`);
    }

    const provider = target.provider ?? config.tmux.defaultProvider;
    const cwd = this.expandUserPath(target.cwd, fallbackCwd);
    const command = this.buildTmuxProviderCommand(
      chatId,
      provider,
      config,
      cwd,
      additionalDirectories,
    );
    const create =
      target.create && target.sessionName
        ? {
            sessionName: target.sessionName,
            provider,
            command,
            cwd,
          }
        : undefined;

    return {
      target: target.target,
      ...(create ? { create } : {}),
      captureLines: config.tmux.captureLines,
      pollIntervalMs: config.tmux.pollIntervalMs,
      settleDelayMs: config.tmux.settleDelayMs,
      turnTimeoutMs: config.tmux.turnTimeoutMs,
      observeOnStart: true,
    };
  }

  private buildTmuxProviderCommand(
    chatId: string,
    provider: DirectBackendKind,
    config: BridgeConfig,
    cwd: string,
    additionalDirectories: string[],
  ): string {
    const base = config.tmux.providerCommands[provider];
    const model = this.resolveModel(chatId, provider, config);
    const reasoningEffort = this.configReasoningEffort(provider, config);

    if (provider === 'codex') {
      const args = [
        ...(model ? ['--model', model] : []),
        ...(reasoningEffort
          ? ['--config', `model_reasoning_effort="${reasoningEffort}"`]
          : []),
        '--dangerously-bypass-approvals-and-sandbox',
        '--cd',
        cwd,
        ...additionalDirectories.flatMap((dir) => ['--add-dir', dir]),
      ];
      return [base, ...args.map((arg) => shellQuote(arg))].join(' ');
    }

    const permissionMode = config.claude.permissionMode;
    const args = [
      ...(model ? ['--model', model] : []),
      ...(reasoningEffort ? ['--effort', reasoningEffort] : []),
      '--permission-mode',
      permissionMode,
      ...additionalDirectories.flatMap((dir) => ['--add-dir', dir]),
      ...(permissionMode === 'bypassPermissions'
        ? ['--allow-dangerously-skip-permissions']
        : []),
    ];
    return [base, ...args.map((arg) => shellQuote(arg))].join(' ');
  }

  private handleStreamMessage(session: Session, msg: StreamMessage): void {
    const { chatId } = session;

    switch (msg.type) {
      case 'session_init':
        session.sessionId = msg.sessionId;
        session.state = 'active';
        logger.info(
          { chatId, sessionId: msg.sessionId },
          'Backend session initialized',
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

        // Record transcript. Observation turns only mirror existing tmux pane
        // output, so they should not look like assistant replies to a user turn.
        if (finalText && !msg.isObservation) {
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
        if (finalText && !msg.isObservation) {
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
        this.resolveTurnCompletion(session);

        // Create fresh progress card for next turn.
        // Old card manages its own delete timer via complete() — don't reset it.
        session.progressCard = new ProgressCardController(this.larkClient, chatId);
        break;
      }

      case 'error':
        logger.error({ chatId, error: msg.error }, 'Backend session error');
        if (session.backendKind === 'tmux') {
          this.chatState.clearTmux(chatId);
        }
        // Signal turn completion on error too
        this.resolveTurnCompletion(session);
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
        '会话空闲超时，已自动关闭。发送新消息可开启新对话。',
      ).catch((err) => {
        logger.error(
          { err, chatId: session.chatId },
          'Error closing idle session',
        );
      });
    }, session.config.session.idleTimeoutMs);
  }

  private armMaxDurationTimer(session: Session, delayMs: number): void {
    if (session.maxDurationTimer) clearTimeout(session.maxDurationTimer);
    session.maxDurationTimer = setTimeout(() => {
      logger.info({ chatId: session.chatId }, 'Session max duration reached');
      this.closeSession(
        session,
        '会话已达最长时限，自动关闭。发送新消息可开启新对话。',
      ).catch((err) => {
        logger.error(
          { err, chatId: session.chatId },
          'Error closing max-duration session',
        );
      });
    }, delayMs);
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
    this.resolveTurnCompletion(session);

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
      model: s.model ?? null,
      reasoningEffort: s.reasoningEffort ?? null,
      tmuxTarget: s.tmuxTarget ?? null,
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

      case 'help':
        await this.commandHelp(chatId);
        return;

      case 'state':
        await this.commandState(chatId);
        return;

      case 'hold':
        await this.commandHold(chatId);
        return;

      case 'release':
        await this.commandRelease(chatId);
        return;

      case 'model':
        await this.commandModel(msg, cmd);
        return;

      case 'tmux':
        await this.commandTmux(msg, cmd);
        return;

      case 'new': {
        const { backendKind, clearedTmuxTarget } =
          await this.selectBackendKindForStart(chatId);
        if (clearedTmuxTarget) {
          await this.feishu.sendMessage(
            chatId,
            `⚠️ tmux target \`${clearedTmuxTarget}\` 已不存在，已清除接管状态。`,
          );
        }
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
    ackPrefixOverride?: string,
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

    const ackPrefix =
      ackPrefixOverride ??
      (persistBackend
        ? `🔁 已切换到 ${backendKind} 后端。`
        : `🆕 已开启新会话（${backendKind}）。`);

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

    let session: Session;
    try {
      session = await this.startCreate(chatId, msg.chatType, backendKind);
    } catch (err: any) {
      if (backendKind !== 'tmux') throw err;

      const failedTarget = this.chatState.getTmux(chatId)?.target;
      this.chatState.clearTmux(chatId);
      await this.feishu.sendMessage(
        chatId,
        `⚠️ tmux 接管启动失败${failedTarget ? `（${failedTarget}）` : ''}，已清除接管状态并改用 ${this.config.defaultBackend} 后端处理这条 prompt。错误：${err?.message || String(err)}`,
      );
      session = await this.startCreate(
        chatId,
        msg.chatType,
        this.config.defaultBackend,
      );
    }
    const continuationMsg: FeishuMessage = {
      ...msg,
      text: inlinePrompt,
    };
    await this.enqueueUserDelivery(session, continuationMsg);
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
      '✋ 会话已保持，将不会被空闲或最长时限自动关闭。发送 `/release` 可恢复自动关闭计时。',
    );
  }

  private async commandHelp(chatId: string): Promise<void> {
    await this.feishu.sendMessage(
      chatId,
      [
        '**lark-bridge 命令**',
        '`/new [prompt]`：关闭当前会话，用当前默认后端开新会话',
        '`/provider claude|codex [prompt]`：切换直接 SDK 后端',
        '`/model [model|reset] [prompt]`：查看/设置当前直接后端模型',
        '`/hold` / `/release`：保持会话 / 恢复自动关闭',
        '`/state`：查看当前会话状态',
        `tmux：${this.config.tmux.enabled ? '已启用' : '已禁用（需在配置中开启）'}`,
        '`/tmux new <session> [claude|codex] [cwd]`：新建或接管 tmux session，先同步当前 pane 输出',
        '`/tmux attach <target>`：接管已有 tmux pane，先只读观察当前输出',
        '`/tmux detach`：退出飞书接管，不关闭 tmux',
        '`/tmux ls|list` / `/tmux capture [lines]` / `/tmux state`：查看 tmux 状态',
        'tmux 普通消息会快速送入 pane；复杂任务运行中只更新临时处理状态，最终只返回本轮命令输出',
        '`/tmux kill <session>`：仅关闭当前 chat 正在接管的 tmux session',
        '',
        '普通消息会进入当前后端；其他未识别的 `/xxx` 会原样透传给后端。',
      ].join('\n'),
    );
  }

  private async commandRelease(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) {
      await this.feishu.sendMessage(chatId, '当前没有活跃会话。');
      return;
    }
    if (!session.held) {
      await this.feishu.sendMessage(chatId, '当前会话未处于保持状态。');
      return;
    }

    session.held = false;
    const maxRemainingMs =
      session.createdAt + session.config.session.maxDurationMs - Date.now();

    if (maxRemainingMs <= 0) {
      await this.closeSession(
        session,
        '会话已超过最长时限，解除保持后已自动关闭。发送新消息可开启新对话。',
      );
      return;
    }

    this.resetIdleTimer(session);
    this.armMaxDurationTimer(session, maxRemainingMs);

    await this.feishu.sendMessage(
      chatId,
      [
        '▶️ 会话已恢复自动关闭计时。',
        `空闲关闭：约 ${this.minutesFromMs(session.config.session.idleTimeoutMs)} 分钟后`,
        `最长时限：约 ${this.minutesFromMs(maxRemainingMs)} 分钟后`,
      ].join('\n'),
    );
  }

  private async commandModel(
    msg: FeishuMessage,
    cmd: Extract<BotCommand, { type: 'model' }>,
  ): Promise<void> {
    const { chatId } = msg;
    const session = this.sessions.get(chatId);
    const backendKind =
      session?.backendKind ??
      this.selectBackendKind(chatId);
    if (!this.isDirectBackend(backendKind)) {
      await this.feishu.sendMessage(
        chatId,
        '当前是 tmux 接管模式。`/model` 只作用于直接 Claude/Codex 后端；tmux 里的 codex/claude code 模型请在对应 CLI 内切换，或先 `/provider claude|codex` 回到直接后端。',
      );
      return;
    }
    const configModel = this.configModel(backendKind, this.config);
    const overrideModel = this.chatState.getModel(chatId, backendKind);
    const effectiveModel = overrideModel ?? configModel;

    if (cmd.action === 'show') {
      const lines = [
        '**🧠 模型设置**',
        `后端：\`${backendKind}\``,
        session
          ? `当前会话模型：${this.modelLabel(session.model)}`
          : '当前没有活跃会话。',
        `下次新会话模型：${this.modelLabel(effectiveModel)}`,
        `推理强度：${this.modelLabel(this.configReasoningEffort(backendKind, this.config))}`,
        overrideModel
          ? `本 chat 覆盖：${this.modelLabel(overrideModel)}`
          : '本 chat 覆盖：未设置',
        `配置默认：${this.modelLabel(configModel)}`,
        '',
        '用法：`/model <model> [prompt]` 或 `/model reset [prompt]`',
      ];
      await this.feishu.sendMessage(chatId, lines.join('\n'));
      return;
    }

    if (cmd.action === 'reset') {
      this.chatState.clearModel(chatId, backendKind);
      await this.commandResetSession(
        msg,
        backendKind,
        cmd.prompt,
        false,
        `🧠 已清除 ${backendKind} 模型覆盖，将使用 ${this.modelLabel(configModel)}。`,
      );
      return;
    }

    this.chatState.setModel(chatId, backendKind, cmd.model);
    await this.commandResetSession(
      msg,
      backendKind,
      cmd.prompt,
      false,
      `🧠 已将 ${backendKind} 模型切换为 ${this.modelLabel(cmd.model)}。`,
    );
  }

  private async commandTmux(
    msg: FeishuMessage,
    cmd: Extract<BotCommand, { type: 'tmux' }>,
  ): Promise<void> {
    const { chatId } = msg;
    if (
      !this.config.tmux.enabled &&
      cmd.action !== 'state' &&
      cmd.action !== 'help' &&
      cmd.action !== 'detach'
    ) {
      await this.feishu.sendMessage(chatId, 'tmux 后端已被配置禁用。');
      return;
    }

    switch (cmd.action) {
      case 'help':
        await this.feishu.sendMessage(
          chatId,
          [
            '**tmux 命令**',
            `配置：${this.config.tmux.enabled ? '已启用' : '已禁用（需设置 tmux.enabled=true）'}`,
            '`/tmux new <session> [claude|codex] [cwd]`：创建或接管 tmux session，并同步当前 pane 输出',
            '`/tmux attach <session[:window[.pane]]>`：接管已有 pane，并先观察未完成输出',
            '`/tmux detach`：飞书端退出接管，不关闭 tmux',
            '`/tmux ls|list`：列出 tmux sessions',
            '`/tmux capture [lines]`：抓取当前 pane 输出',
            '普通消息会快速送入 pane；复杂任务运行中只更新临时处理状态，最终只返回本轮命令输出',
            '`/tmux kill <session>`：仅关闭当前 chat 正在接管的 tmux session',
            '`/provider claude|codex`：切回直接 SDK 后端',
          ].join('\n'),
        );
        return;

      case 'state':
        await this.commandTmuxState(chatId);
        return;

      case 'ls':
        await this.commandTmuxList(chatId);
        return;

      case 'kill':
        await this.commandTmuxKill(chatId, cmd.sessionName);
        return;

      case 'capture':
        await this.commandTmuxCapture(chatId, cmd.lines);
        return;

      case 'detach':
        await this.commandTmuxDetach(chatId);
        return;

      case 'attach':
        await this.commandTmuxAttach(msg, cmd.target);
        return;

      case 'new':
        await this.commandTmuxNew(msg, cmd);
        return;
    }
  }

  private async commandTmuxList(chatId: string): Promise<void> {
    try {
      const sessions = await listTmuxSessions();
      if (sessions.length === 0) {
        await this.feishu.sendMessage(chatId, '当前没有 tmux session。');
        return;
      }
      const lines = sessions.map(
        (s) =>
          `- \`${s.name}\` windows=${s.windows} attached=${s.attached} created=${s.created}`,
      );
      await this.feishu.sendMessage(chatId, lines.join('\n'));
    } catch (err: any) {
      await this.feishu.sendMessage(
        chatId,
        `未能列出 tmux session：${err?.message || String(err)}`,
      );
    }
  }

  private async commandTmuxKill(
    chatId: string,
    sessionName: string,
  ): Promise<void> {
    if (!isValidTmuxSessionName(sessionName)) {
      await this.feishu.sendMessage(
        chatId,
        'tmux session 名只能包含字母、数字、下划线、点和横线，且不能以横线开头。',
      );
      return;
    }

    const existing = this.sessions.get(chatId);
    const persisted = this.chatState.getTmux(chatId);
    const killsCurrent =
      (existing?.backendKind === 'tmux' &&
        this.tmuxSessionName(existing.tmuxTarget) === sessionName) ||
      this.tmuxSessionName(persisted?.target) === sessionName;

    if (!killsCurrent) {
      await this.feishu.sendMessage(
        chatId,
        '出于安全边界，`/tmux kill` 只能关闭当前 chat 正在接管的 tmux session。先用 `/tmux state` 确认目标。',
      );
      return;
    }

    if (!(await tmuxTargetExists(sessionName))) {
      await this.feishu.sendMessage(
        chatId,
        `未找到 tmux session：\`${sessionName}\`。可先用 \`/tmux ls\` 查看。`,
      );
      return;
    }

    if (killsCurrent && existing?.backendKind === 'tmux') {
      await this.closeSession(existing).catch((err) => {
        logger.error({ err, chatId }, 'Error closing tmux bridge before kill');
      });
    }

    try {
      await killTmuxSession(sessionName);
      if (killsCurrent) this.chatState.clearTmux(chatId);
      await this.feishu.sendMessage(
        chatId,
        `已关闭 tmux session：\`${sessionName}\`${killsCurrent ? '，并清除了当前 chat 的 tmux 接管目标。' : '。'}`,
      );
    } catch (err: any) {
      await this.feishu.sendMessage(
        chatId,
        `关闭 tmux session \`${sessionName}\` 失败：${err?.message || String(err)}`,
      );
    }
  }

  private tmuxSessionName(target: string | undefined): string | null {
    if (!target) return null;
    return target.split(':', 1)[0] || null;
  }

  private async commandTmuxState(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    const target = this.chatState.getTmux(chatId);
    const lines = ['**tmux 接管状态**'];
    lines.push(`配置：${this.config.tmux.enabled ? '已启用' : '已禁用'}`);
    lines.push(`当前后端：\`${session?.backendKind ?? this.selectBackendKind(chatId)}\``);
    lines.push(
      target
        ? `持久目标：\`${target.target}\`${target.create ? '（可自动创建）' : ''}`
        : '持久目标：未设置',
    );
    if (target?.provider) lines.push(`tmux provider：\`${target.provider}\``);
    if (target?.cwd) lines.push(`tmux cwd：\`${target.cwd}\``);
    if (session?.backendKind === 'tmux') {
      lines.push(`活跃接管：\`${session.tmuxTarget ?? target?.target ?? '-'}\``);
    }
    await this.feishu.sendMessage(chatId, lines.join('\n'));
  }

  private async commandTmuxCapture(
    chatId: string,
    lines?: number,
  ): Promise<void> {
    const target =
      this.sessions.get(chatId)?.tmuxTarget ??
      this.chatState.getTmux(chatId)?.target;
    if (!target) {
      await this.feishu.sendMessage(
        chatId,
        '当前没有 tmux 接管目标。先用 `/tmux attach <target>` 或 `/tmux new <session>`。',
      );
      return;
    }
    const requestedLines = lines ?? this.config.tmux.captureLines;
    const captureLines = Math.min(
      Math.max(1, requestedLines),
      MAX_TMUX_CAPTURE_LINES,
    );
    try {
      const text = clipTmuxCapture(await captureTmuxTarget(target, captureLines));
      await this.feishu.sendMessage(
        chatId,
        text.trim() || `tmux \`${target}\` 当前没有可见输出。`,
      );
    } catch (err: any) {
      await this.feishu.sendMessage(
        chatId,
        `抓取 tmux \`${target}\` 失败：${err?.message || String(err)}`,
      );
    }
  }

  private async commandTmuxDetach(chatId: string): Promise<void> {
    const existing = this.sessions.get(chatId);
    if (existing?.backendKind === 'tmux') {
      await this.closeSession(existing).catch((err) => {
        logger.error({ err, chatId }, 'Error closing tmux bridge session');
      });
    }
    this.chatState.clearTmux(chatId);
    await this.feishu.sendMessage(
      chatId,
      '已从 tmux 接管模式退出；tmux session 仍在后台运行。',
    );
  }

  private async commandTmuxAttach(
    msg: FeishuMessage,
    target: string,
  ): Promise<void> {
    if (!(await tmuxTargetExists(target))) {
      await this.feishu.sendMessage(
        msg.chatId,
        `未找到 tmux target：\`${target}\`。可先用 \`/tmux ls\` 查看。`,
      );
      return;
    }

    this.chatState.setTmux(msg.chatId, { target });
    this.chatState.setBackend(msg.chatId, 'tmux');
    await this.startTmuxBridgeSession(
      msg,
      `已接管 tmux \`${target}\`，正在同步当前 pane 输出。后续普通消息会在上一轮输出稳定后发送到同一个 pane；电脑端可直接 \`tmux attach -t ${target}\` 接手。`,
    );
  }

  private async commandTmuxNew(
    msg: FeishuMessage,
    cmd: Extract<BotCommand, { type: 'tmux'; action: 'new' }>,
  ): Promise<void> {
    if (!isValidTmuxSessionName(cmd.sessionName)) {
      await this.feishu.sendMessage(
        msg.chatId,
        'tmux session 名只能包含字母、数字、下划线、点和横线，且不能以横线开头。',
      );
      return;
    }

    const provider = cmd.provider ?? this.config.tmux.defaultProvider;
    const cwd = this.expandUserPath(
      cmd.cwd,
      this.workspaceDirFor(msg.chatId, this.config),
    );
    const existed = await tmuxTargetExists(cmd.sessionName);
    const target: ChatTmuxTarget = {
      target: cmd.sessionName,
      create: true,
      sessionName: cmd.sessionName,
      provider,
      cwd,
    };
    this.chatState.setTmux(msg.chatId, target);
    this.chatState.setBackend(msg.chatId, 'tmux');
    await this.startTmuxBridgeSession(
      msg,
      existed
        ? `已接管已有 tmux \`${cmd.sessionName}\`，正在同步当前 pane 输出。后续普通消息会在上一轮输出稳定后发送到同一个 pane；电脑端可直接 \`tmux attach -t ${cmd.sessionName}\` 接手。`
        : `已准备 tmux \`${cmd.sessionName}\`（provider=${provider}, cwd=\`${cwd}\`），正在同步当前 pane 输出。后续普通消息会在上一轮输出稳定后发送到同一个 pane；电脑端可直接 \`tmux attach -t ${cmd.sessionName}\` 接手。`,
    );
  }

  private async startTmuxBridgeSession(
    msg: FeishuMessage,
    ack: string,
  ): Promise<void> {
    const { chatId } = msg;

    const inflight = this.creatingPromises.get(chatId);
    if (inflight) {
      await inflight.catch(() => {});
    }

    const existing = this.sessions.get(chatId);
    if (existing && existing.state !== 'closed') {
      await this.closeSession(existing).catch((err) => {
        logger.error({ err, chatId }, 'Error closing previous session for /tmux');
      });
    }

    try {
      await this.startCreate(chatId, msg.chatType, 'tmux');
      await this.feishu.sendMessage(chatId, ack);
    } catch (err: any) {
      logger.error({ err, chatId }, 'tmux session start failed');
      this.chatState.clearTmux(chatId);
      await this.feishu.sendMessage(
        chatId,
        `⚠️ tmux 接管失败：${err?.message || String(err)}`,
      );
    }
  }

  private async commandState(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) {
      const persistedBackend = this.chatState.getBackend(chatId);
      const tmuxTarget = this.chatState.getTmux(chatId)?.target;
      const backendStr = persistedBackend
        ? `（默认后端：${persistedBackend}${
            persistedBackend === 'tmux' && tmuxTarget ? `:${tmuxTarget}` : ''
          }）`
        : '';
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
    if (session.backendKind === 'tmux') {
      lines.push(`tmux：\`${session.tmuxTarget ?? '-'}\``);
    } else {
      lines.push(`模型：${this.modelLabel(session.model)}`);
      lines.push(`推理强度：${this.modelLabel(session.reasoningEffort)}`);
    }
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=@%+.,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function clipTmuxCapture(text: string): string {
  if (text.length <= MAX_TMUX_CAPTURE_CHARS) return text;
  return text.slice(text.length - MAX_TMUX_CAPTURE_CHARS);
}
