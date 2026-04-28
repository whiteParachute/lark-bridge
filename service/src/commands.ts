/**
 * Bot 命令解析与帮助文本。
 *
 * 命令在消息**首行首词**触发，且首词必须命中白名单（new/provider/hold/state）。
 * 其他 `/xxx` 不被识别，原样透传给后端 LLM —— 这样 Claude Code 自身的
 * slash command（`/init`、`/review` 等）和 Markdown 中以 `/` 开头的内容
 * 都不受影响。
 *
 * 设计取舍：仅取首行 + 首词，意味着 `/new\n附加内容` 中的"附加内容"会被
 * 忽略；如果 `/new` 后面跟 inline prompt（同一行），则保留为新会话首条
 * 消息。这样语义最清晰，避免歧义。
 */
import type { BackendKind } from './backend/index.js';

const COMMAND_WHITELIST = new Set(['new', 'provider', 'hold', 'state']);
const VALID_BACKENDS = new Set<BackendKind>(['claude', 'codex']);

export type BotCommand =
  | { type: 'new'; prompt?: string }
  | { type: 'provider'; backend: BackendKind; prompt?: string }
  | { type: 'hold' }
  | { type: 'state' }
  | { type: 'invalid'; reason: string };

/**
 * 尝试把消息文本解析为 bot 命令。
 *
 * 返回 null：不是命令（首词不在白名单），调用方应该把消息当普通输入透传。
 * 返回 BotCommand：是命令，调用方应分流到 dispatcher。
 *
 * 命令格式：
 *   /new [prompt...]
 *   /provider <claude|codex> [prompt...]
 *   /hold
 *   /state
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
      if (!VALID_BACKENDS.has(backendArg as BackendKind)) {
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
    case 'state': {
      return { type: 'state' };
    }
    default:
      return null;
  }
}
