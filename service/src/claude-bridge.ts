/**
 * Claude Agent SDK wrapper.
 *
 * Adapted from HappyClaw's claude-session.ts — simplified for single-user
 * bridge use. Relies on settingSources: ['project', 'user'] to load all
 * plugins (including aria-memory) automatically.
 */

import {
  query,
  type Query,
  type SDKUserMessage,
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

// ─── Stream Message Types ────────────────────────────────────

export interface StreamMessage {
  type:
    | 'text_delta'
    | 'thinking_delta'
    | 'tool_use_start'
    | 'tool_use_end'
    | 'turn_complete'
    | 'session_init'
    | 'error';
  text?: string;
  sessionId?: string;
  error?: string;
  toolName?: string;
  toolUseId?: string;
  isError?: boolean;
  turnId?: number;
}

// ─── Claude Bridge ───────────────────────────────────────────

export interface ClaudeBridgeOptions {
  model: string;
  cwd: string;
  additionalDirectories?: string[];
  sessionId?: string;
  permissionMode?: string;
}

export class ClaudeBridge {
  private stream: MessageStream | null = null;
  private queryRef: Query | null = null;
  private outputLoop: Promise<void> | null = null;
  private accumulatedText = '';
  private accumulatedThinking = '';
  private activeToolBlocks = new Map<number, string>(); // index → toolName
  private currentTurnId = 0;

  start(
    opts: ClaudeBridgeOptions,
    onMessage: (msg: StreamMessage) => void,
  ): void {
    this.stream = new MessageStream();
    this.accumulatedText = '';
    this.accumulatedThinking = '';
    this.activeToolBlocks.clear();
    this.currentTurnId = 0;

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
            permissionMode: (opts.permissionMode || 'plan') as any,
            ...(opts.permissionMode === 'bypassPermissions'
              ? { allowDangerouslySkipPermissions: true }
              : {}),
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

  private processMessage(
    message: any,
    onMessage: (msg: StreamMessage) => void,
  ): void {
    // Stamp turnId on all emitted messages
    const turnId = this.currentTurnId;
    const emit = (msg: StreamMessage) => onMessage({ ...msg, turnId });

    if (message.type === 'system' && message.subtype === 'init') {
      onMessage({
        type: 'session_init',
        sessionId: message.session_id,
      });
      return;
    }

    if (message.type === 'assistant') {
      // Complete assistant message — extract final text
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            this.accumulatedText = block.text;
          }
        }
      }
      return;
    }

    if (message.type === 'stream_event') {
      const event = message.event;
      if (!event) return;

      // Thinking
      if (
        event.type === 'content_block_delta' &&
        event.delta?.type === 'thinking_delta'
      ) {
        this.accumulatedThinking += event.delta.text || '';
        emit({
          type: 'thinking_delta',
          text: this.accumulatedThinking,
        });
        return;
      }

      // Text output
      if (
        event.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta'
      ) {
        this.accumulatedText += event.delta.text || '';
        this.accumulatedThinking = ''; // Clear thinking when text starts
        emit({
          type: 'text_delta',
          text: this.accumulatedText,
        });
        return;
      }

      // Tool use start
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          this.activeToolBlocks.set(event.index, block.name);
          emit({
            type: 'tool_use_start',
            toolName: block.name,
            toolUseId: block.id,
          });
        }
        return;
      }

      // Tool use end (content_block_stop)
      if (event.type === 'content_block_stop') {
        const toolName = this.activeToolBlocks.get(event.index);
        if (toolName) {
          this.activeToolBlocks.delete(event.index);
          emit({
            type: 'tool_use_end',
            toolName,
          });
        }
        return;
      }

      return;
    }

    if (message.type === 'result') {
      const isSuccess = message.subtype === 'success';
      const finalText = isSuccess
        ? message.result || this.accumulatedText || ''
        : this.accumulatedText || '';
      const errorMsg = !isSuccess ? message.stop_reason || 'execution error' : undefined;

      emit({
        type: 'turn_complete',
        text: finalText,
        isError: !isSuccess,
        error: errorMsg,
      });

      // Reset for next turn
      this.accumulatedText = '';
      this.accumulatedThinking = '';
      this.activeToolBlocks.clear();
      this.currentTurnId++;
    }
  }

  pushMessage(
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): void {
    if (!this.stream) throw new Error('ClaudeBridge not started');
    this.stream.push(text, images);
  }

  getTurnId(): number {
    return this.currentTurnId;
  }

  async interrupt(): Promise<void> {
    try {
      await this.queryRef?.interrupt();
    } catch (err) {
      logger.debug({ err }, 'interrupt() failed (best effort)');
    }
  }

  end(): void {
    this.stream?.end();
  }

  async waitForCompletion(): Promise<void> {
    await this.outputLoop;
  }
}
