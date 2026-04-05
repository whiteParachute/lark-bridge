/**
 * Feishu Streaming Card Controller
 *
 * Adapted from HappyClaw's feishu-streaming-card.ts.
 * Implements CardKit 2.0 streaming cards with typing-machine effect.
 * Uses im.message.patch API to update card content in real-time.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from './logger.js';

// ─── Card Template Builders ───────────────────────────────────

const CARD_MD_LIMIT = 4000;

function splitAtParagraphs(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;
    chunks.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function buildCard(
  text: string,
  state: 'streaming' | 'completed' | 'aborted',
): object {
  const lines = text.split('\n');
  let title = '';
  let bodyStartIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (/^#{1,3}\s+/.test(lines[i])) {
      title = lines[i].replace(/^#+\s*/, '').trim();
      bodyStartIdx = i + 1;
    }
    break;
  }

  const body = lines.slice(bodyStartIdx).join('\n').trim();

  if (!title) {
    const firstLine = (lines.find((l) => l.trim()) || '')
      .replace(/[*_`#\[\]]/g, '')
      .trim();
    title =
      firstLine.length > 40
        ? firstLine.slice(0, 37) + '...'
        : firstLine || 'Reply';
  }

  const elements: Array<Record<string, unknown>> = [];
  const contentToRender = body || text.trim();

  if (contentToRender.length > CARD_MD_LIMIT) {
    const chunks = splitAtParagraphs(contentToRender, CARD_MD_LIMIT);
    for (const chunk of chunks) {
      elements.push({ tag: 'markdown', content: chunk });
    }
  } else if (contentToRender) {
    const sections = contentToRender.split(/\n-{3,}\n/);
    for (let i = 0; i < sections.length; i++) {
      if (i > 0) elements.push({ tag: 'hr' });
      const s = sections[i].trim();
      if (s) elements.push({ tag: 'markdown', content: s });
    }
  }

  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: text.trim() || '...' });
  }

  const noteMap = {
    streaming: '⏳ 生成中...',
    completed: '',
    aborted: '⚠️ 已中断',
  };
  const headerTemplate = {
    streaming: 'wathet',
    completed: 'indigo',
    aborted: 'orange',
  };

  if (noteMap[state]) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: noteMap[state] }],
    });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: headerTemplate[state],
    },
    elements,
  };
}

// ─── Flush Controller ─────────────────────────────────────────

class FlushController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushTime = 0;
  private lastFlushedLength = 0;
  private pendingFlush: (() => Promise<void>) | null = null;
  private readonly minInterval: number;
  private readonly minDelta: number;

  constructor(minInterval = 1200, minDelta = 50) {
    this.minInterval = minInterval;
    this.minDelta = minDelta;
  }

  schedule(currentLength: number, flushFn: () => Promise<void>): void {
    if (currentLength - this.lastFlushedLength < this.minDelta) {
      if (!this.timer) {
        this.pendingFlush = flushFn;
        this.timer = setTimeout(() => {
          this.timer = null;
          this.executeFlush();
        }, this.minInterval);
      } else {
        this.pendingFlush = flushFn;
      }
      return;
    }

    this.pendingFlush = flushFn;
    const elapsed = Date.now() - this.lastFlushTime;
    if (elapsed >= this.minInterval) {
      this.clearTimer();
      this.executeFlush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.executeFlush();
      }, this.minInterval - elapsed);
    }
  }

  async forceFlush(flushFn: () => Promise<void>): Promise<void> {
    this.clearTimer();
    this.pendingFlush = flushFn;
    await this.executeFlush();
  }

  private async executeFlush(): Promise<void> {
    const fn = this.pendingFlush;
    this.pendingFlush = null;
    if (!fn) return;
    this.lastFlushTime = Date.now();
    try {
      await fn();
    } catch {
      // Swallow flush errors
    }
  }

  markFlushed(length: number): void {
    this.lastFlushedLength = length;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.clearTimer();
    this.pendingFlush = null;
  }
}

// ─── Streaming Card Controller ────────────────────────────────

type StreamingState =
  | 'idle'
  | 'creating'
  | 'streaming'
  | 'completed'
  | 'aborted'
  | 'error';

export class StreamingCardController {
  private state: StreamingState = 'idle';
  private messageId: string | null = null;
  private accumulatedText = '';
  private flushCtrl: FlushController;
  private patchFailCount = 0;
  private readonly client: lark.Client;
  private readonly chatId: string;
  private readonly replyToMsgId?: string;
  private readonly onFallback?: () => void;

  constructor(opts: {
    client: lark.Client;
    chatId: string;
    replyToMsgId?: string;
    onFallback?: () => void;
  }) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.replyToMsgId = opts.replyToMsgId;
    this.onFallback = opts.onFallback;
    this.flushCtrl = new FlushController();
  }

  isActive(): boolean {
    return this.state === 'streaming' || this.state === 'creating';
  }

  append(text: string): void {
    this.accumulatedText = text;

    if (this.state === 'idle') {
      this.state = 'creating';
      this.createInitialCard().catch((err) => {
        logger.warn({ err, chatId: this.chatId }, 'Streaming card create failed');
        this.state = 'error';
        this.onFallback?.();
      });
      return;
    }

    if (this.state === 'streaming') {
      this.schedulePatch();
    }
  }

  async complete(finalText: string): Promise<void> {
    if (this.state !== 'streaming' && this.state !== 'creating') return;
    this.accumulatedText = finalText;
    this.state = 'completed';
    this.flushCtrl.dispose();

    if (this.messageId) {
      try {
        await this.patchCard('completed');
      } catch {
        // Best effort
      }
    }
  }

  async abort(reason?: string): Promise<void> {
    if (this.state === 'completed' || this.state === 'aborted') return;
    const wasActive = this.isActive();
    this.state = 'aborted';
    this.flushCtrl.dispose();

    if (this.messageId && wasActive) {
      if (reason) this.accumulatedText += `\n\n---\n*${reason}*`;
      try {
        await this.patchCard('aborted');
      } catch {
        // Best effort
      }
    }
  }

  dispose(): void {
    this.flushCtrl.dispose();
  }

  // ─── Internal ──────────────────────────────────────────

  private async createInitialCard(): Promise<void> {
    const card = buildCard(this.accumulatedText || '...', 'streaming');
    const content = JSON.stringify(card);

    let resp: any;
    if (this.replyToMsgId) {
      resp = await this.client.im.message.reply({
        path: { message_id: this.replyToMsgId },
        data: { content, msg_type: 'interactive' },
      });
    } else {
      resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: this.chatId,
          msg_type: 'interactive',
          content,
        },
      });
    }

    this.messageId = resp?.data?.message_id || null;
    if (!this.messageId) throw new Error('No message_id in response');

    if (this.state !== 'creating') {
      const finalState = this.state as 'completed' | 'aborted';
      try {
        await this.patchCard(finalState);
      } catch {
        // Best effort
      }
      return;
    }

    this.state = 'streaming';
    if (this.accumulatedText.length > 3) this.schedulePatch();
  }

  private schedulePatch(): void {
    if (this.patchFailCount >= 2) {
      this.state = 'error';
      this.flushCtrl.dispose();
      this.onFallback?.();
      return;
    }

    this.flushCtrl.schedule(this.accumulatedText.length, async () => {
      await this.patchCard('streaming');
    });
  }

  private async patchCard(
    displayState: 'streaming' | 'completed' | 'aborted',
  ): Promise<void> {
    if (!this.messageId) return;
    const card = buildCard(this.accumulatedText, displayState);
    const content = JSON.stringify(card);

    try {
      await this.client.im.v1.message.patch({
        path: { message_id: this.messageId },
        data: { content },
      });
      this.flushCtrl.markFlushed(this.accumulatedText.length);
      this.patchFailCount = 0;
    } catch (err) {
      this.patchFailCount++;
      throw err;
    }
  }
}
