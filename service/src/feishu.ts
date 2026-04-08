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

export interface FeishuClientOptions {
  appId: string;
  appSecret: string;
  onMessage: (msg: FeishuMessage) => void;
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
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly onMessage: (msg: FeishuMessage) => void;
  private seenMessages = new Map<string, number>(); // messageId → timestamp
  private startedAt = Date.now();

  constructor(opts: FeishuClientOptions) {
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.client = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      appType: lark.AppType.SelfBuild,
    });
    this.onMessage = opts.onMessage;
  }

  getLarkClient(): lark.Client {
    return this.client;
  }

  async connect(): Promise<void> {
    const eventDispatcher = new lark.EventDispatcher({}).register({
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
    });

    await this.wsClient.start({ eventDispatcher });
    logger.info('Feishu WebSocket connected');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      try {
        // WSClient may not expose stop() in all SDK versions — best effort
        const ws = this.wsClient as any;
        if (typeof ws.stop === 'function') await ws.stop();
        else if (typeof ws.close === 'function') await ws.close();
      } catch (err) {
        logger.debug({ err }, 'WSClient disconnect failed (best effort)');
      }
      this.wsClient = null;
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
