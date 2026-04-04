/**
 * Claude Agent SDK wrapper.
 *
 * Adapted from HappyClaw's claude-session.ts — simplified for single-user
 * bridge use. No MCP servers, no custom hooks, no predefined agents.
 * Relies on settingSources: ['project', 'user'] to load all plugins
 * (including aria-memory) automatically.
 */

import {
  query,
  type Query,
  type SDKUserMessage,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { logger } from './logger.js';

// ─── Message Stream ──────────────────────────────────────────

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): void {
    type MediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    const validMediaTypes: MediaType[] = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ];
    function toMediaType(s: string): MediaType {
      return validMediaTypes.includes(s as MediaType)
        ? (s as MediaType)
        : 'image/jpeg';
    }

    let content: any;

    if (images && images.length > 0) {
      content = [
        { type: 'text', text },
        ...images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: toMediaType(img.mimeType || 'image/jpeg'),
            data: img.data,
          },
        })),
      ];
    } else {
      content = text;
    }

    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage);
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ─── Claude Bridge ───────────────────────────────────────────

export interface ClaudeBridgeOptions {
  model: string;
  cwd: string;
  additionalDirectories?: string[];
  sessionId?: string;
}

export interface StreamMessage {
  type: 'text_delta' | 'turn_complete' | 'session_init' | 'error';
  text?: string;
  sessionId?: string;
  error?: string;
}

export class ClaudeBridge {
  private stream: MessageStream | null = null;
  private queryRef: Query | null = null;
  private outputLoop: Promise<void> | null = null;
  private accumulatedText = '';
  private onMessage: ((msg: StreamMessage) => void) | null = null;

  /**
   * Start the Claude session and begin consuming output.
   * Call onMessage for each streaming event.
   */
  start(
    opts: ClaudeBridgeOptions,
    onMessage: (msg: StreamMessage) => void,
  ): void {
    this.stream = new MessageStream();
    this.onMessage = onMessage;
    this.accumulatedText = '';

    const stream = this.stream;
    const self = this;

    this.outputLoop = (async () => {
      try {
        const q = query({
          prompt: stream as any,
          options: {
            model: opts.model || 'sonnet',
            cwd: opts.cwd,
            additionalDirectories: opts.additionalDirectories,
            ...(opts.sessionId ? { resume: opts.sessionId } : {}),
            permissionMode: 'bypassPermissions' as const,
            allowDangerouslySkipPermissions: true,
            settingSources: ['project', 'user'],
            includePartialMessages: true,
          },
        });
        self.queryRef = q;

        for await (const message of q) {
          self.processMessage(message as any, onMessage);
        }
      } catch (err: any) {
        logger.error({ err }, 'Claude session error');
        onMessage({
          type: 'error',
          error: err.message || String(err),
        });
      }
    })();
  }

  private processMessage(message: any, onMessage: (msg: StreamMessage) => void): void {
    if (message.type === 'system' && message.subtype === 'init') {
      onMessage({
        type: 'session_init',
        sessionId: message.session_id,
      });
    } else if (message.type === 'assistant') {
      // Extract text from complete assistant message
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            this.accumulatedText = block.text;
          }
        }
      }
    } else if (message.type === 'stream_event') {
      // BetaRawMessageStreamEvent — check for content_block_delta with text_delta
      const event = message.event;
      if (!event) return;

      // The Anthropic SDK uses event.type like 'content_block_delta'
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        this.accumulatedText += event.delta.text || '';
        onMessage({
          type: 'text_delta',
          text: this.accumulatedText,
        });
      }
    } else if (message.type === 'result') {
      // SDKResultSuccess has .result, SDKResultError does not
      const finalText =
        ('result' in message ? message.result : null) ||
        this.accumulatedText ||
        '(no response)';
      onMessage({
        type: 'turn_complete',
        text: finalText,
      });
      // Reset for next turn
      this.accumulatedText = '';
    }
  }

  /**
   * Push a user message into the active session.
   */
  pushMessage(
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): void {
    if (!this.stream) throw new Error('ClaudeBridge not started');
    this.stream.push(text, images);
  }

  async interrupt(): Promise<void> {
    await this.queryRef?.interrupt();
  }

  end(): void {
    this.stream?.end();
  }

  async waitForCompletion(): Promise<void> {
    await this.outputLoop;
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }
}
