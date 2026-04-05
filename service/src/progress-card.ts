/**
 * Feishu Progress Card — shows reasoning/tool execution progress.
 *
 * Adapted from HappyClaw's feishu-progress-card.ts.
 * Lifecycle: idle → creating → active → completed (auto-delete after 15s)
 *
 * This card is SEPARATE from the streaming card:
 * - Progress card: shows thinking + tool use (temporary, deleted after turn)
 * - Streaming card: shows final text output (permanent)
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from './logger.js';

type ProgressState = 'idle' | 'creating' | 'active' | 'completed' | 'aborted';

interface ToolInfo {
  name: string;
  startedAt: number;
  completed: boolean;
  durationMs?: number;
}

const DELETE_DELAY_MS = 15_000;
const FLUSH_INTERVAL_MS = 2_000;

function buildProgressCard(
  tools: ToolInfo[],
  thinkingText: string,
  state: ProgressState,
): object {
  const elements: Array<Record<string, unknown>> = [];

  // Thinking section
  if (thinkingText) {
    const truncated =
      thinkingText.length > 500
        ? '...' + thinkingText.slice(-497)
        : thinkingText;
    elements.push({
      tag: 'markdown',
      content: `> 💭 ${truncated.replace(/\n/g, '\n> ')}`,
    });
  }

  // Tools section
  const activeTools = tools.filter((t) => !t.completed);
  const completedTools = tools.filter((t) => t.completed);

  for (const tool of activeTools) {
    const elapsed = ((Date.now() - tool.startedAt) / 1000).toFixed(1);
    elements.push({
      tag: 'markdown',
      content: `🔧 **${tool.name}** — ${elapsed}s`,
    });
  }

  for (const tool of completedTools) {
    const dur = tool.durationMs
      ? `${(tool.durationMs / 1000).toFixed(1)}s`
      : '';
    elements.push({
      tag: 'markdown',
      content: `✅ ~~${tool.name}~~ ${dur}`,
    });
  }

  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: '⏳ 正在处理...' });
  }

  const headerTemplate = {
    idle: 'wathet',
    creating: 'wathet',
    active: 'wathet',
    completed: 'green',
    aborted: 'orange',
  };

  const title =
    state === 'completed'
      ? '✅ 处理完成'
      : state === 'aborted'
        ? '⚠️ 已中断'
        : '🤔 正在思考...';

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: headerTemplate[state],
    },
    elements,
  };
}

export class ProgressCardController {
  private state: ProgressState = 'idle';
  private messageId: string | null = null;
  private tools: ToolInfo[] = [];
  private thinkingText = '';
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private deleteTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly client: lark.Client;
  private readonly chatId: string;

  constructor(client: lark.Client, chatId: string) {
    this.client = client;
    this.chatId = chatId;
  }

  isActive(): boolean {
    return this.state === 'active' || this.state === 'creating';
  }

  feedThinking(text: string): void {
    this.thinkingText = text;
    this.markDirty();
  }

  feedToolStart(toolName: string): void {
    this.tools.push({
      name: toolName,
      startedAt: Date.now(),
      completed: false,
    });
    this.markDirty();
  }

  feedToolEnd(toolName: string): void {
    const tool = this.tools.find((t) => t.name === toolName && !t.completed);
    if (tool) {
      tool.completed = true;
      tool.durationMs = Date.now() - tool.startedAt;
    }
    this.markDirty();
  }

  /**
   * Complete the progress card — patch to "completed" state, then delete after 15s.
   */
  async complete(): Promise<void> {
    if (this.state !== 'active' && this.state !== 'creating') return;
    this.state = 'completed';
    this.clearFlushTimer();

    if (this.messageId) {
      try {
        await this.patchCard('completed');
      } catch {
        // Best effort
      }
      this.scheduleDelete();
    }
  }

  async abort(reason?: string): Promise<void> {
    if (this.state === 'completed' || this.state === 'aborted') return;
    this.state = 'aborted';
    this.clearFlushTimer();

    if (this.messageId) {
      if (reason) {
        this.tools.push({
          name: reason,
          startedAt: Date.now(),
          completed: true,
          durationMs: 0,
        });
      }
      try {
        await this.patchCard('aborted');
      } catch {
        // Best effort
      }
      this.scheduleDelete();
    }
  }

  dispose(): void {
    this.clearFlushTimer();
    if (this.deleteTimer) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = null;
    }
  }

  /** Reset for next turn (reuse same controller). */
  reset(): void {
    this.dispose();
    this.state = 'idle';
    this.messageId = null;
    this.tools = [];
    this.thinkingText = '';
    this.dirty = false;
  }

  // ─── Internal ──────────────────────────────────────────

  private markDirty(): void {
    this.dirty = true;

    if (this.state === 'idle') {
      this.state = 'creating';
      this.createCard().catch((err) => {
        logger.warn({ err, chatId: this.chatId }, 'Progress card create failed');
        this.state = 'idle'; // Allow retry
      });
      return;
    }

    if (this.state === 'active' && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  private async createCard(): Promise<void> {
    const card = buildProgressCard(this.tools, this.thinkingText, 'active');
    const content = JSON.stringify(card);

    const resp = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: this.chatId,
        msg_type: 'interactive',
        content,
      },
    });

    this.messageId = resp?.data?.message_id || null;
    if (!this.messageId) {
      this.state = 'idle';
      return;
    }

    // Check if state changed during async creation
    if (this.state !== 'creating') {
      const finalState = this.state as 'completed' | 'aborted';
      try {
        await this.patchCard(finalState);
      } catch {
        // Best effort
      }
      if (finalState === 'completed' || finalState === 'aborted') {
        this.scheduleDelete();
      }
      return;
    }

    this.state = 'active';
    this.dirty = false;
  }

  private async flush(): Promise<void> {
    if (!this.dirty || !this.messageId || this.state !== 'active') return;
    this.dirty = false;
    try {
      await this.patchCard('active');
    } catch {
      // Swallow
    }
  }

  private async patchCard(displayState: ProgressState): Promise<void> {
    if (!this.messageId) return;
    const card = buildProgressCard(this.tools, this.thinkingText, displayState);
    await this.client.im.v1.message.patch({
      path: { message_id: this.messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  private scheduleDelete(): void {
    this.deleteTimer = setTimeout(async () => {
      if (this.messageId) {
        try {
          await this.client.im.v1.message.delete({
            path: { message_id: this.messageId },
          });
        } catch {
          // Best effort — message may already be deleted
        }
      }
      this.messageId = null;
    }, DELETE_DELAY_MS);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
