/**
 * Bot 命令解析与帮助文本。
 *
 * 命令在消息**首行首词**触发，且首词必须命中白名单
 *（help/new/provider/hold/release/state/model/tmux）。
 * 其他 `/xxx` 不被识别，原样透传给后端 LLM —— 这样 Claude Code 自身的
 * slash command（`/init`、`/review` 等）和 Markdown 中以 `/` 开头的内容
 * 都不受影响。
 *
 * 设计取舍：仅取首行 + 首词，意味着 `/new\n附加内容` 中的"附加内容"会被
 * 忽略；如果 `/new` 后面跟 inline prompt（同一行），则保留为新会话首条
 * 消息。这样语义最清晰，避免歧义。
 */
import type { BackendKind, DirectBackendKind } from './backend/index.js';

const COMMAND_WHITELIST = new Set([
  'new',
  'help',
  'provider',
  'hold',
  'release',
  'state',
  'model',
  'tmux',
]);
const VALID_BACKENDS = new Set<DirectBackendKind>(['claude', 'codex']);

export type BotCommand =
  | { type: 'help' }
  | { type: 'new'; prompt?: string }
  | { type: 'provider'; backend: BackendKind; prompt?: string }
  | { type: 'hold' }
  | { type: 'release' }
  | { type: 'state' }
  | { type: 'model'; action: 'show' }
  | { type: 'model'; action: 'reset'; prompt?: string }
  | { type: 'model'; action: 'set'; model: string; prompt?: string }
  | {
      type: 'tmux';
      action: 'new';
      sessionName: string;
      provider?: DirectBackendKind;
      cwd?: string;
    }
  | { type: 'tmux'; action: 'attach'; target: string }
  | { type: 'tmux'; action: 'detach' }
  | { type: 'tmux'; action: 'ls' }
  | { type: 'tmux'; action: 'kill'; sessionName: string }
  | { type: 'tmux'; action: 'capture'; lines?: number }
  | { type: 'tmux'; action: 'state' | 'help' }
  | { type: 'invalid'; reason: string };

/**
 * 尝试把消息文本解析为 bot 命令。
 *
 * 返回 null：不是命令（首词不在白名单），调用方应该把消息当普通输入透传。
 * 返回 BotCommand：是命令，调用方应分流到 dispatcher。
 *
 * 命令格式：
 *   /help
 *   /new [prompt...]
 *   /provider <claude|codex> [prompt...]
 *   /hold
 *   /release
 *   /state
 *   /model [model|reset] [prompt...]
 *   /tmux new <session> [claude|codex] [cwd]
 *   /tmux attach <target>
 *   /tmux detach | ls | list | kill <session> | capture [lines] | state
 */
export function parseCommand(text: string): BotCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  // 仅取首行
  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  // 去掉前导 `/`
  const body = firstLine.slice(1);

  // 首词与剩余内容
  const firstSpace = body.search(/\s/);
  const firstWord = (firstSpace < 0 ? body : body.slice(0, firstSpace))
    .toLowerCase();
  const rest =
    firstSpace < 0 ? '' : body.slice(firstSpace).trim();

  if (!COMMAND_WHITELIST.has(firstWord)) return null;

  switch (firstWord) {
    case 'help': {
      return { type: 'help' };
    }
    case 'new': {
      return { type: 'new', prompt: rest || undefined };
    }
    case 'provider': {
      // 提取后端名（首词），剩余作为 inline prompt
      const restFirstSpace = rest.search(/\s/);
      const backendArg = (restFirstSpace < 0 ? rest : rest.slice(0, restFirstSpace))
        .toLowerCase();
      const promptPart =
        restFirstSpace < 0 ? '' : rest.slice(restFirstSpace).trim();

      if (!backendArg) {
        return {
          type: 'invalid',
          reason: '用法：`/provider <claude|codex> [prompt]`',
        };
      }
      if (!VALID_BACKENDS.has(backendArg as DirectBackendKind)) {
        return {
          type: 'invalid',
          reason: `未知后端 "${backendArg}"。可选值：claude、codex`,
        };
      }
      return {
        type: 'provider',
        backend: backendArg as BackendKind,
        prompt: promptPart || undefined,
      };
    }
    case 'hold': {
      return { type: 'hold' };
    }
    case 'release': {
      return { type: 'release' };
    }
    case 'state': {
      return { type: 'state' };
    }
    case 'model': {
      if (!rest) return { type: 'model', action: 'show' };

      const restFirstSpace = rest.search(/\s/);
      const modelArg =
        restFirstSpace < 0 ? rest : rest.slice(0, restFirstSpace);
      const promptPart =
        restFirstSpace < 0 ? '' : rest.slice(restFirstSpace).trim();

      if (modelArg.toLowerCase() === 'reset') {
        return {
          type: 'model',
          action: 'reset',
          prompt: promptPart || undefined,
        };
      }
      return {
        type: 'model',
        action: 'set',
        model: modelArg,
        prompt: promptPart || undefined,
      };
    }
    case 'tmux': {
      return parseTmuxCommand(rest);
    }
    default:
      return null;
  }
}

function parseTmuxCommand(rest: string): BotCommand {
  if (!rest) return { type: 'tmux', action: 'state' };

  const parts = rest.split(/\s+/).filter(Boolean);
  const action = (parts.shift() || '').toLowerCase();

  switch (action) {
    case 'help':
      return { type: 'tmux', action: 'help' };
    case 'state':
      return { type: 'tmux', action: 'state' };
    case 'ls':
    case 'list':
      return { type: 'tmux', action: 'ls' };
    case 'kill': {
      const sessionName = parts[0];
      if (!sessionName) {
        return {
          type: 'invalid',
          reason: '用法：`/tmux kill <session>`',
        };
      }
      return { type: 'tmux', action: 'kill', sessionName };
    }
    case 'detach':
      return { type: 'tmux', action: 'detach' };
    case 'capture': {
      if (!parts[0]) return { type: 'tmux', action: 'capture' };
      const lines = Number.parseInt(parts[0], 10);
      if (!Number.isFinite(lines) || lines <= 0) {
        return {
          type: 'invalid',
          reason: '用法：`/tmux capture [lines]`，lines 必须是正整数。',
        };
      }
      return { type: 'tmux', action: 'capture', lines };
    }
    case 'attach': {
      const target = parts[0];
      if (!target) {
        return {
          type: 'invalid',
          reason: '用法：`/tmux attach <session[:window[.pane]]>`',
        };
      }
      return { type: 'tmux', action: 'attach', target };
    }
    case 'new': {
      const sessionName = parts.shift();
      if (!sessionName) {
        return {
          type: 'invalid',
          reason: '用法：`/tmux new <session> [claude|codex] [cwd]`',
        };
      }

      let provider: DirectBackendKind | undefined;
      if (parts[0] && VALID_BACKENDS.has(parts[0].toLowerCase() as DirectBackendKind)) {
        provider = parts.shift()!.toLowerCase() as DirectBackendKind;
      }

      const cwd = parts[0];
      return {
        type: 'tmux',
        action: 'new',
        sessionName,
        provider,
        cwd,
      };
    }
    default:
      return {
        type: 'invalid',
        reason:
          '未知 tmux 命令。用法：`/tmux new|attach|detach|ls|list|capture|state|help`',
      };
  }
}
