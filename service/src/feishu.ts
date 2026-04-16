/**
 * Simplified Feishu WebSocket client.
 *
 * Handles message receive/send. Adapted from HappyClaw's feishu.ts
 * but without multi-user routing, DB storage, group management, etc.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from './logger.js';
import { withRetry } from './retry.js';

// ─── Types ───────────────────────────────────────────────────

export interface FeishuMessage {
  chatId: string;
  messageId: string;
  chatType: 'p2p' | 'group';
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  filePaths?: string[];
  senderOpenId: string;
  createTimeMs: number;
}

export interface WsWatchdogConfig {
  enabled: boolean;
  maxConsecutiveFailures: number;
  reconnectCooldownMs: number;
  silenceTimeoutMs: number;
}

export interface FeishuClientOptions {
  appId: string;
  appSecret: string;
  onMessage: (msg: FeishuMessage) => void;
  wsWatchdog?: WsWatchdogConfig;
}

// ─── Message Content Extraction ──────────────────────────────

function extractMessageContent(
  messageType: string,
  content: string,
): { text: string; imageKeys?: string[]; fileInfos?: { fileKey: string; filename: string }[] } {
  try {
    const parsed = JSON.parse(content);

    if (messageType === 'text') {
      return { text: parsed.text || '' };
    }

    if (messageType === 'post') {
      const lines: string[] = [];
      const imageKeys: string[] = [];
      const post = parsed.post || parsed;
      let contentData: any;
      if (Array.isArray(post.content)) {
        contentData = post;
      } else {
        contentData = post.zh_cn || post.en_us || Object.values(post)[0];
      }
      if (!contentData || !Array.isArray(contentData.content)) {
        return { text: '' };
      }
      if (contentData.title) lines.push(contentData.title);

      for (const paragraph of contentData.content) {
        const segments = Array.isArray(paragraph) ? paragraph : [paragraph];
        const parts: string[] = [];
        for (const seg of segments) {
          if (!seg || typeof seg !== 'object') continue;
          if (seg.tag === 'text' && typeof seg.text === 'string') parts.push(seg.text);
          else if (seg.tag === 'a' && typeof seg.text === 'string') parts.push(seg.text);
          else if (seg.tag === 'at') parts.push(`@${seg.user_name || seg.text || '用户'}`);
          else if (seg.tag === 'img' && seg.image_key) {
            imageKeys.push(seg.image_key);
            parts.push('[图片]');
          } else if (typeof seg.text === 'string') parts.push(seg.text);
        }
        if (parts.length > 0) lines.push(parts.join(''));
      }

      return {
        text: lines.join('\n'),
        imageKeys: imageKeys.length > 0 ? imageKeys : undefined,
      };
    }

    if (messageType === 'image') {
      return { text: '', imageKeys: parsed.image_key ? [parsed.image_key] : undefined };
    }

    if (messageType === 'file') {
      const fileKey = parsed.file_key;
      const filename = parsed.file_name || '';
      if (fileKey) {
        return {
          text: `[文件: ${filename || fileKey}]`,
          fileInfos: [{ fileKey, filename }],
        };
      }
    }

    if (messageType === 'sticker') return { text: `[表情包]` };
    if (messageType === 'audio') return { text: `[语音消息]` };

    return { text: '' };
  } catch {
    return { text: '' };
  }
}

// ─── Feishu Client ───────────────────────────────────────────

export class FeishuClient {
  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private eventDispatcher: lark.EventDispatcher | null = null;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly onMessage: (msg: FeishuMessage) => void;
  private seenMessages = new Map<string, number>(); // messageId → timestamp
  private startedAt = Date.now();

  // ── WS Watchdog state ──
  private readonly watchdog: WsWatchdogConfig;
  private consecutiveWsFailures = 0;
  private lastMessageAt = Date.now();
  private lastReconnectAt = 0;
  private isReconnecting = false;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: FeishuClientOptions) {
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.client = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      appType: lark.AppType.SelfBuild,
    });
    this.onMessage = opts.onMessage;
    this.watchdog = opts.wsWatchdog ?? {
      enabled: true,
      maxConsecutiveFailures: 5,
      reconnectCooldownMs: 60_000,
      silenceTimeoutMs: 30 * 60 * 1000,
    };
  }

  getLarkClient(): lark.Client {
    return this.client;
  }

  async connect(): Promise<void> {
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          await this.handleMessage(data);
        } catch (err) {
          logger.error({ err }, 'Error handling Feishu message');
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.info,
      logger: this.createWatchdogLogger(),
    });

    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    this.consecutiveWsFailures = 0;
    this.lastMessageAt = Date.now();
    logger.info('Feishu WebSocket connected');

    // Start silence watchdog timer
    this.startSilenceTimer();
  }

  async disconnect(): Promise<void> {
    this.stopSilenceTimer();
    this.closeWsClient();
  }

  // ── WS Watchdog ────────────────────────────────────────

  /**
   * Create a custom logger for WSClient that intercepts error/info messages
   * to detect consecutive connection failures.
   */
  /**
   * Close the current WSClient. Extracted to avoid duck-typing duplication.
   */
  private closeWsClient(): void {
    if (!this.wsClient) return;
    try {
      const ws = this.wsClient as any;
      if (typeof ws.close === 'function') ws.close({ force: true });
      else if (typeof ws.stop === 'function') ws.stop();
    } catch (err) {
      logger.debug({ err }, 'WSClient close failed (best effort)');
    }
    this.wsClient = null;
  }

  private createWatchdogLogger(): {
    error: (...msg: any[]) => void;
    warn: (...msg: any[]) => void;
    info: (...msg: any[]) => void;
    debug: (...msg: any[]) => void;
    trace: (...msg: any[]) => void;
  } {
    const self = this;
    const wsFailurePatterns = [
      /timeout of \d+ms exceeded/,
      /unable to connect/i,
      /send data failed/i,
      /write EPIPE/i,
      /socket hang up/i,
      /ECONNRESET/i,
      /ECONNREFUSED/i,
    ];

    function flattenArgs(args: any[]): string {
      return args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    }

    function checkForFailure(...args: any[]): void {
      const msg = flattenArgs(args);
      for (const pattern of wsFailurePatterns) {
        if (pattern.test(msg)) {
          self.onWsFailure(msg);
          return;
        }
      }
    }

    // Lark SDK passes mixed types (strings, arrays, objects) to its logger.
    // pino expects (obj?, msg, ...interpolation). We flatten SDK args into
    // a single string to be safe with pino's API.
    function pinoLog(level: 'error' | 'warn' | 'info' | 'debug' | 'trace', args: any[]): void {
      logger[level]({ sdk: 'ws' }, flattenArgs(args));
    }

    return {
      error: (...args: any[]) => { pinoLog('error', args); checkForFailure(...args); },
      warn:  (...args: any[]) => { pinoLog('warn', args); checkForFailure(...args); },
      info:  (...args: any[]) => { pinoLog('info', args); },
      debug: (...args: any[]) => { pinoLog('debug', args); },
      trace: (...args: any[]) => { pinoLog('trace', args); },
    };
  }

  private onWsFailure(detail: string): void {
    if (!this.watchdog.enabled) return;

    this.consecutiveWsFailures++;
    logger.warn(
      { consecutiveFailures: this.consecutiveWsFailures, max: this.watchdog.maxConsecutiveFailures, detail },
      'WS connection failure detected',
    );

    if (this.consecutiveWsFailures >= this.watchdog.maxConsecutiveFailures) {
      this.triggerReconnect('consecutive_failures');
    }
  }

  private async triggerReconnect(reason: string): Promise<void> {
    if (this.isReconnecting) return;

    const now = Date.now();
    const sinceLast = now - this.lastReconnectAt;
    if (sinceLast < this.watchdog.reconnectCooldownMs) {
      logger.info(
        { reason, cooldownRemainingSec: Math.ceil((this.watchdog.reconnectCooldownMs - sinceLast) / 1000) },
        'Reconnect cooldown active, skipping',
      );
      return;
    }

    this.isReconnecting = true;
    this.lastReconnectAt = now;
    logger.info(
      { reason, consecutiveFailures: this.consecutiveWsFailures },
      'Watchdog triggering WS reconnect',
    );

    try {
      // Tear down old connection
      this.closeWsClient();

      // Small delay to let things settle
      await new Promise(r => setTimeout(r, 2000));

      // Create fresh WSClient
      this.wsClient = new lark.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        loggerLevel: lark.LoggerLevel.info,
        logger: this.createWatchdogLogger(),
      });

      await this.wsClient.start({ eventDispatcher: this.eventDispatcher! });
      this.consecutiveWsFailures = 0;
      this.lastMessageAt = Date.now();
      this.startSilenceTimer();
      logger.info('WS reconnect successful');
    } catch (err) {
      logger.error({ err, reason }, 'WS reconnect failed');
      // Schedule a retry after cooldown instead of waiting for silence timer
      const retryMs = this.watchdog.reconnectCooldownMs;
      logger.info(
        { retryInSec: Math.ceil(retryMs / 1000) },
        'Scheduling reconnect retry after cooldown',
      );
      setTimeout(() => this.triggerReconnect('reconnect_retry'), retryMs);
    } finally {
      this.isReconnecting = false;
    }
  }

  private startSilenceTimer(): void {
    this.stopSilenceTimer();
    if (!this.watchdog.enabled || this.watchdog.silenceTimeoutMs <= 0) return;

    // Check every 5 minutes
    const checkInterval = Math.min(this.watchdog.silenceTimeoutMs / 2, 5 * 60 * 1000);
    this.silenceTimer = setInterval(() => {
      const silenceDuration = Date.now() - this.lastMessageAt;
      if (silenceDuration >= this.watchdog.silenceTimeoutMs) {
        logger.warn(
          { silenceMinutes: Math.round(silenceDuration / 60_000) },
          'No messages received for extended period, triggering reconnect',
        );
        this.triggerReconnect('silence_timeout');
      }
    }, checkInterval);
  }

  private stopSilenceTimer(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /**
   * Add an emoji reaction to a message. Returns the reaction_id for later removal.
   */
  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const res: any = await withRetry(
        () =>
          (this.client.im.messageReaction.create as any)({
            path: { message_id: messageId },
            data: { reaction_type: { emoji_type: emojiType } },
          }),
        { label: 'addReaction' },
      );
      return res?.data?.reaction_id || null;
    } catch (err: any) {
      logger.warn(
        { messageId, emojiType, code: err?.code, msg: err?.msg || err?.message },
        'Failed to add reaction',
      );
      return null;
    }
  }

  /**
   * Remove an emoji reaction from a message.
   */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await (this.client.im.messageReaction.delete as any)({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (err) {
      logger.debug({ err, messageId, reactionId }, 'Failed to remove reaction');
    }
  }

  /**
   * Send a text message (as interactive card).
   */
  async sendMessage(chatId: string, text: string): Promise<string | undefined> {
    const card = this.buildSimpleCard(text);
    try {
      const resp = await withRetry(
        () =>
          this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: JSON.stringify(card),
            },
          }),
        { label: 'sendMessage.card' },
      );
      return resp?.data?.message_id || undefined;
    } catch (err: any) {
      // Fallback to plain text if card fails
      logger.warn({ err, chatId }, 'Card send failed, trying plain text');
      try {
        const resp = await withRetry(
          () =>
            this.client.im.v1.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text }),
              },
            }),
          { label: 'sendMessage.text' },
        );
        return resp?.data?.message_id || undefined;
      } catch (err2) {
        logger.error({ err: err2, chatId }, 'Plain text send also failed');
        return undefined;
      }
    }
  }

  /**
   * Download an image by image_key and return base64.
   */
  async downloadImage(
    messageId: string,
    imageKey: string,
  ): Promise<{ data: string; mimeType: string } | null> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      });
      if (!resp) return null;

      // Lark SDK returns { writeFile, getReadableStream, headers }
      const readable = (resp as any).getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of readable) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const buffer = Buffer.concat(chunks);
      const data = buffer.toString('base64');
      // Detect MIME type from magic bytes
      let mimeType = 'image/jpeg';
      if (buffer[0] === 0x89 && buffer[1] === 0x50) mimeType = 'image/png';
      else if (buffer[0] === 0x47 && buffer[1] === 0x49) mimeType = 'image/gif';
      else if (buffer[0] === 0x52 && buffer[1] === 0x49) mimeType = 'image/webp';

      return { data, mimeType };
    } catch (err) {
      logger.warn({ err, imageKey }, 'Failed to download image');
      return null;
    }
  }

  /**
   * Download a file by file_key and save to disk.
   */
  async downloadFile(
    messageId: string,
    fileKey: string,
    _filename: string,
    savePath: string,
  ): Promise<string | null> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });
      if (!resp) return null;

      const { mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(savePath), { recursive: true });

      // Lark SDK provides writeFile helper
      await (resp as any).writeFile(savePath);
      return savePath;
    } catch (err) {
      logger.warn({ err, fileKey, savePath }, 'Failed to download file');
      return null;
    }
  }

  // ─── Internal ──────────────────────────────────────────

  private async handleMessage(data: any): Promise<void> {
    const message = data.message;
    const messageId = message.message_id;

    // WS is alive — reset failure counter
    this.consecutiveWsFailures = 0;
    this.lastMessageAt = Date.now();

    // Dedup
    if (this.seenMessages.has(messageId)) return;
    this.seenMessages.set(messageId, Date.now());
    // Cleanup: keep at most 1000 entries, drop oldest half when exceeded
    if (this.seenMessages.size > 1000) {
      const entries = [...this.seenMessages.entries()]
        .sort((a, b) => a[1] - b[1]);
      const toDelete = entries.slice(0, Math.floor(entries.length / 2));
      for (const [id] of toDelete) {
        this.seenMessages.delete(id);
      }
    }

    // Skip stale messages (before bridge started)
    const createTimeMs = this.toEpochMs(message.create_time);
    if (createTimeMs > 0 && createTimeMs < this.startedAt - 5000) return;

    const chatId = message.chat_id;
    const chatType = (message.chat_type === 'p2p' ? 'p2p' : 'group') as 'p2p' | 'group';
    const senderOpenId = data.sender?.sender_id?.open_id || '';

    // Extract content
    const { text, imageKeys, fileInfos } = extractMessageContent(
      message.message_type,
      message.content,
    );

    if (!text && !imageKeys?.length && !fileInfos?.length) return;

    // Download images
    let images: Array<{ data: string; mimeType: string }> | undefined;
    if (imageKeys && imageKeys.length > 0) {
      const downloaded = await Promise.all(
        imageKeys.map((key) => this.downloadImage(messageId, key)),
      );
      const valid = downloaded.filter(
        (img): img is { data: string; mimeType: string } => img !== null,
      );
      if (valid.length > 0) images = valid;
    }

    // Download files
    let filePaths: string[] | undefined;
    if (fileInfos && fileInfos.length > 0) {
      // Files will be downloaded by session-manager to the correct workspace
      // For now, just pass the info through
      filePaths = fileInfos.map((f) => `${f.fileKey}:${f.filename}`);
    }

    this.onMessage({
      chatId,
      messageId,
      chatType,
      text: text || (images ? '[图片]' : '[文件]'),
      images,
      filePaths,
      senderOpenId,
      createTimeMs,
    });
  }

  private toEpochMs(value: string | number | undefined): number {
    const numeric = typeof value === 'number' ? value : Number(value ?? 0);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return numeric < 1e12 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
  }

  private buildSimpleCard(text: string): object {
    const lines = text.split('\n');
    let title = 'Reply';
    const firstLine = lines.find((l) => l.trim());
    if (firstLine) {
      const clean = firstLine.replace(/[*_`#\[\]]/g, '').trim();
      title = clean.length > 40 ? clean.slice(0, 37) + '...' : clean || 'Reply';
    }

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template: 'indigo',
      },
      elements: [{ tag: 'markdown', content: text }],
    };
  }
}
