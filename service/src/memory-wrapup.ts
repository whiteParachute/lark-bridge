/**
 * aria-memory pendingWrapup 登记。
 *
 * 模型：lark-bridge 不处理 wrapup，只在 feishu 会话关闭时把**真实 SDK
 * transcript 路径**追加到 ~/.aria-memory/meta.json.pendingWrapups[]。primary
 * host 上的 claude/codex CLI 启动时 aria-memory 自己的 SessionStart hook 会
 * drain 这个队列。
 *
 * 这个模块刻意不合成任何 transcript 文件 —— aria-memory spec 明确说"对话
 * 记录不复制到记忆目录，wrapup 时直接读原始路径"。
 *
 * 后端差异：
 * - **claude**：claude-agent-sdk `query()` 不会触发外层 SessionEnd hook，需要
 *   lark-bridge 这边 emulate。路径可由 `cwd` + `sessionId` 直接拼出（与 SDK
 *   写到 ~/.claude/projects/<encodedCwd>/<sessionId>.jsonl 的规则一致）。
 * - **codex**：~/.codex/hooks.json 里全局注册了 aria-memory 的 SessionEnd，
 *   codex CLI 子进程结束时已经会自动登记 rollout。lark-bridge 这边做 no-op
 *   即可，避免重复登记。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger.js';
import { ARIA_MEMORY_DIR, META_PATH, withMetaLock } from './meta-lock.js';
import type { BackendKind } from './backend/index.js';

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  imageCount?: number;
}

export interface RegisterArgs {
  chatId: string;
  backendKind: BackendKind;
  sessionId?: string;
  cwd?: string;
}

/**
 * 把真实 SDK transcript 路径 append 到 meta.json.pendingWrapups。
 *
 * 没装 aria-memory（vault 目录不存在）→ debug log 后静默退出，不打扰用户。
 * vault 存在但 meta.json 缺 → warn（可能装坏了）。
 * 找不到 transcript 路径 → debug log，不阻塞会话关闭流程。
 */
export async function registerPendingWrapup(args: RegisterArgs): Promise<void> {
  if (!ARIA_MEMORY_DIR || !existsSync(ARIA_MEMORY_DIR)) {
    logger.debug(
      { chatId: args.chatId },
      'aria-memory not installed, skipping wrapup hook',
    );
    return;
  }
  if (!existsSync(META_PATH)) {
    logger.warn(
      { metaPath: META_PATH },
      'aria-memory installed but meta.json missing — vault may be corrupt',
    );
    return;
  }

  const transcriptPath = resolveTranscriptPath(args);
  if (!transcriptPath) {
    logger.debug(
      { chatId: args.chatId, backend: args.backendKind, sessionId: args.sessionId },
      'No transcript path resolved (codex relies on global ~/.codex/hooks.json; claude resolution failed)',
    );
    return;
  }

  try {
    await withMetaLock((meta) => {
      const pending: any[] = (meta.pendingWrapups as any[]) || [];
      if (pending.some((p: any) => p.transcriptPath === transcriptPath)) {
        return;
      }
      pending.push({
        transcriptPath,
        recordedAt: new Date().toISOString(),
        trigger: 'lark_bridge_session_end',
      });
      meta.pendingWrapups = pending;
      logger.info(
        {
          chatId: args.chatId,
          backend: args.backendKind,
          transcriptPath,
          pendingCount: pending.length,
        },
        'Registered pending wrapup',
      );
    });
  } catch (err) {
    logger.error({ err, chatId: args.chatId }, 'Failed to register pending wrapup');
  }
}

function resolveTranscriptPath(args: RegisterArgs): string | null {
  if (args.backendKind === 'claude') {
    return resolveClaudePath(args);
  }
  // codex 后端：~/.codex/hooks.json 全局 SessionEnd 已经会自动登记 rollout，
  // 这边不重复做。如果以后发现全局 hook 不生效，再补 ~/.codex/state_*.sqlite
  // 反查逻辑。
  return null;
}

/**
 * claude-agent-sdk 把 transcript 写到：
 *   ~/.claude/projects/<encodedCwd>/<sessionId>.jsonl
 * 其中 encodedCwd = '-' + cwd.replaceAll('/', '-')。
 */
function resolveClaudePath(args: RegisterArgs): string | null {
  if (!args.cwd || !args.sessionId) return null;
  const encodedCwd = '-' + args.cwd.replace(/\//g, '-');
  const candidate = resolve(
    homedir(),
    '.claude',
    'projects',
    encodedCwd,
    `${args.sessionId}.jsonl`,
  );
  if (!existsSync(candidate)) {
    logger.debug({ candidate }, 'claude transcript path not found on disk');
    return null;
  }
  return candidate;
}
