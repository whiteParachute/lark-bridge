/**
 * Codex SDK 后端实现。
 *
 * 用 `@openai/codex-sdk` (>= 0.125) 的 `Thread.runStreamed()` 接收事件，把
 * codex 的事件协议适配为 bridge 统一的 `StreamMessage`。
 *
 * 与 claude-agent-sdk 的差异（已知 + 设计取舍）：
 * - **无 prompt 流**：codex 是"每条 prompt 一次 run"模型；本实现维护一个
 *   prompt 队列，由内部 output loop 顺序消费。
 * - **审批走 policy 而非回调（YOLO）**：bridge 模式无人值守，固定
 *   `approvalPolicy: 'never'` + `sandboxMode: 'danger-full-access'` —— 与 claude
 *   后端 `canUseTool: allow` 等价的"全放行"配置。codex 可执行任意命令，包括
 *   `systemctl` / `sudo`、跨目录 git/npm、改 `~/anywhere`。**安全责任完全下沉
 *   到飞书侧 allowlist**（`feishu.allowedSenders` / `feishu.allowedChats`）。
 *   启动时若白名单宽松会发 warn，见 index.ts。
 * - **图片输入**：SDK 0.125 起支持 `UserInput[]` 但只接 `local_image`（文件路径）。
 *   pushMessage 收到 base64 images 时丢弃并 warn，等需要时再写 tmp 文件支持。
 * - **无 `interrupt()`** 的对等实现：SDK 提供 `AbortSignal` 走 TurnOptions.signal，
 *   `interrupt()` 触发 abort，被运行中的 turn 接收后异常退出。
 * - **粗粒度事件**：codex 的 `agent_message` item 有 `item.updated` /
 *   `item.completed` 两种触发，前者偶尔来一次，后者带最终全文 —— 因此
 *   飞书"打字机"流式可能不那么平滑，可接受。
 *
 * 鉴权：依靠 codex CLI 自身的会话状态（`codex login` 写到 ~/.codex/auth.json）
 * 或环境变量 `CODEX_API_KEY` / `OPENAI_API_KEY`。本类不直接管理凭证。
 *
 * 模型与推理强度：默认完全跟随用户 ~/.codex/config.toml（不传 `model` /
 * `modelReasoningEffort`）。如果 lark-bridge 配置里写了 `codex.model`，会以
 * 该值覆盖 codex 全局默认 —— 比如想让 lark-bridge 走 `gpt-5-codex` 而 CLI
 * 仍用 `gpt-5.5`。
 */

import { Codex, type Thread, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk';
import { logger } from '../logger.js';
import type { Backend, BackendStartOptions, StreamMessage } from './index.js';

interface QueuedInput {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export class CodexBackend implements Backend {
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private outputLoop: Promise<void> | null = null;
  private done = false;
  private currentTurnId = 0;
  private inputQueue: QueuedInput[] = [];
  private waiting: (() => void) | null = null;
  private sessionEmitted = false;
  private currentAbort: AbortController | null = null;

  start(
    opts: BackendStartOptions,
    onMessage: (msg: StreamMessage) => void,
  ): void {
    this.codex = new Codex();
    this.thread = this.codex.startThread({
      workingDirectory: opts.cwd,
      // 跳过 git 仓库检查 —— per-chat 工作目录可能不是 git repo
      skipGitRepoCheck: true,
      // YOLO：与 claude 后端的 `canUseTool: allow` 对齐——codex 可执行任意命令、
      // 跨任意目录读写、systemctl/sudo 不拦。安全责任由 feishu allowlist 承担。
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      // 默认放开网络访问 —— bridge 是无人值守代理，agent 经常需要 git pull/push
      // (aria-memory vault 的远端同步)、curl、ping API 等。Codex sandbox 默认
      // 关网络会导致 DNS resolution failed / connection refused 一类报错。
      networkAccessEnabled: true,
      ...(opts.additionalDirectories && opts.additionalDirectories.length > 0
        ? { additionalDirectories: opts.additionalDirectories }
        : {}),
      ...(opts.model ? { model: opts.model } : {}),
    });

    this.outputLoop = this.runLoop(onMessage).catch((err) => {
      logger.error({ err }, 'Codex backend output loop crashed');
      onMessage({
        type: 'error',
        error: err?.message || String(err),
      });
    });
  }

  private async runLoop(
    onMessage: (msg: StreamMessage) => void,
  ): Promise<void> {
    while (!this.done) {
      if (this.inputQueue.length === 0) {
        await new Promise<void>((r) => {
          this.waiting = r;
        });
        this.waiting = null;
        continue;
      }
      const next = this.inputQueue.shift()!;
      await this.runOneTurn(next, onMessage);
    }
  }

  private async runOneTurn(
    input: QueuedInput,
    onMessage: (msg: StreamMessage) => void,
  ): Promise<void> {
    if (!this.thread) return;
    const turnId = this.currentTurnId;
    const emit = (msg: StreamMessage) => onMessage({ ...msg, turnId });

    if (input.images && input.images.length > 0) {
      logger.warn(
        { count: input.images.length },
        'Codex backend: dropping images (SDK input is string-only)',
      );
    }

    let lastAgentMessage = '';
    let turnSettled = false;
    let settleError: string | undefined;
    let settleIsError = false;

    this.currentAbort = new AbortController();
    try {
      const { events } = await this.thread.runStreamed(input.text, {
        signal: this.currentAbort.signal,
      });
      for await (const ev of events as AsyncGenerator<ThreadEvent>) {
        const settled = this.dispatchEvent(ev, emit, onMessage, (text) => {
          lastAgentMessage = text;
        });
        if (settled) {
          turnSettled = true;
          settleError = settled.error;
          settleIsError = settled.isError;
          break;
        }
      }
    } catch (err: any) {
      logger.error({ err }, 'Codex run failed');
      turnSettled = true;
      settleIsError = true;
      settleError = err?.message || String(err);
    } finally {
      this.currentAbort = null;
    }

    if (!turnSettled) {
      settleIsError = true;
      settleError = 'codex stream ended without turn.completed';
    }

    emit({
      type: 'turn_complete',
      text: lastAgentMessage,
      ...(settleIsError ? { isError: true, error: settleError } : {}),
    });

    this.currentTurnId++;
  }

  /**
   * 把一条 codex 事件适配为 0..N 个 StreamMessage，通过 emit 发出。
   *
   * 返回 null：当前 turn 未结算，继续 iterate。
   * 返回 { isError, error }：当前 turn 已结算（turn.completed 或 turn.failed），
   *   调用方停止迭代并自行发 turn_complete（因为它持有 lastAgentMessage）。
   */
  private dispatchEvent(
    ev: ThreadEvent,
    emit: (msg: StreamMessage) => void,
    onMessage: (msg: StreamMessage) => void,
    setLastMessage: (text: string) => void,
  ): { isError: boolean; error?: string } | null {
    switch (ev.type) {
      case 'thread.started':
        if (!this.sessionEmitted) {
          this.sessionEmitted = true;
          // session_init 不带 turnId（与 claude 后端一致）
          onMessage({
            type: 'session_init',
            sessionId: ev.thread_id,
          });
        }
        return null;

      case 'turn.started':
        return null;

      case 'item.started': {
        const tn = toolNameFromItem(ev.item);
        if (tn) {
          emit({
            type: 'tool_use_start',
            toolName: tn,
            toolUseId: ev.item.id,
          });
        }
        return null;
      }

      case 'item.updated': {
        const item = ev.item;
        if (item.type === 'reasoning') {
          emit({ type: 'thinking_delta', text: item.text });
        } else if (item.type === 'agent_message') {
          setLastMessage(item.text);
          emit({ type: 'text_delta', text: item.text });
        }
        return null;
      }

      case 'item.completed': {
        const item = ev.item;
        if (item.type === 'agent_message') {
          setLastMessage(item.text);
          emit({ type: 'text_delta', text: item.text });
        } else if (item.type === 'reasoning') {
          emit({ type: 'thinking_delta', text: item.text });
        } else {
          const tn = toolNameFromItem(item);
          if (tn) emit({ type: 'tool_use_end', toolName: tn });
        }
        return null;
      }

      case 'turn.completed':
        return { isError: false };

      case 'turn.failed':
        return {
          isError: true,
          error: ev.error?.message || 'turn failed',
        };

      case 'error':
        emit({ type: 'error', error: ev.message });
        return null;

      default:
        return null;
    }
  }

  pushMessage(
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): void {
    if (this.done) {
      throw new Error('CodexBackend already ended');
    }
    this.inputQueue.push({ text, images });
    this.waiting?.();
  }

  getTurnId(): number {
    return this.currentTurnId;
  }

  async interrupt(): Promise<void> {
    // SDK 0.125+ 通过 TurnOptions.signal 支持中断。abort 会让 events 迭代抛错，
    // runOneTurn 的 catch 把它转成 turn_complete + isError。
    this.currentAbort?.abort();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async waitForCompletion(): Promise<void> {
    await this.outputLoop;
  }
}

/**
 * 把 codex 的 ThreadItem 映射成给 progress card 用的工具名。
 * 返回 null 表示这个 item 不是工具型（如 agent_message / reasoning）。
 */
function toolNameFromItem(item: ThreadItem): string | null {
  switch (item.type) {
    case 'command_execution': {
      const cmd = item.command.length > 40 ? item.command.slice(0, 37) + '…' : item.command;
      return `bash: ${cmd}`;
    }
    case 'file_change':
      return 'file_change';
    case 'mcp_tool_call':
      return `${item.server}:${item.tool}`;
    case 'web_search':
      return 'web_search';
    case 'todo_list':
      return null; // todo list 是状态项，不算工具调用
    case 'error':
      return null;
    default:
      return null;
  }
}

