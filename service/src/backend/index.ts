/**
 * 后端抽象 — Bridge 与具体 LLM SDK 之间的边界。
 *
 * 设计目的：让 SessionManager 不关心底层是 claude-agent-sdk 还是 codex-sdk。
 * 所有后端共用一份 `StreamMessage` 协议，差异由各自的 adapter 吸收。
 *
 * Codex SDK 的事件粒度比 claude-sdk 粗（只有 turn 级），所以 codex 后端
 * 实际只会发出 `text_delta` 一次和 `turn_complete` —— 飞书"打字机"流式
 * 效果在 codex 后端会退化为整段一次到位，可接受。
 */

export type BackendKind = 'claude' | 'codex';

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

export interface BackendStartOptions {
  cwd: string;
  additionalDirectories?: string[];
  sessionId?: string;
  permissionMode?: string;
  /** 模型名，按后端各自命名规范（claude: 'sonnet'/'opus'/...; codex: 'gpt-5-codex'/...）*/
  model?: string;
}

/**
 * Backend 接口 —— 所有后端实现必须满足的契约。形态保持与原 ClaudeBridge 一致，
 * 这样 SessionManager 切换实现时 0 改动。
 */
export interface Backend {
  /** 启动会话；onMessage 接收所有流事件 */
  start(opts: BackendStartOptions, onMessage: (msg: StreamMessage) => void): void;
  /** 推送一条用户消息；可携带图像 */
  pushMessage(text: string, images?: Array<{ data: string; mimeType: string }>): void;
  /** 当前 turn 编号（每个 result/turn_complete 后递增），用于跨 turn 卡片归属 */
  getTurnId(): number;
  /** 中断当前 turn（best effort）*/
  interrupt(): Promise<void>;
  /** 优雅关闭输入流，等待输出循环退出 */
  end(): void;
  /** 等待输出循环完全退出 */
  waitForCompletion(): Promise<void>;
}

import { ClaudeBackend } from './claude.js';
import { CodexBackend } from './codex.js';

/**
 * Backend 工厂。新增后端时在这里注册。
 */
export function createBackend(kind: BackendKind): Backend {
  switch (kind) {
    case 'claude':
      return new ClaudeBackend();
    case 'codex':
      return new CodexBackend();
    default: {
      const _exhaustive: never = kind;
      throw new Error(`未知后端类型: ${_exhaustive}`);
    }
  }
}
