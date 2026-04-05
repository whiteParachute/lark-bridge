/**
 * Hook system for lark-bridge.
 *
 * Provides pre/post hooks for session and message lifecycle events.
 * Built-in hook types:
 *   - aria-memory-wrapup: exports transcript and registers pending wrapup
 *   - command: runs a shell command with context as env vars
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { exportAndRegisterWrapup, type TranscriptEntry } from './memory-wrapup.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);

// ─── Hook Definitions ───────────────────────────────────────

export interface AriaMemoryWrapupHook {
  type: 'aria-memory-wrapup';
}

export interface CommandHook {
  type: 'command';
  command: string;
  /** Timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

export type HookDef = AriaMemoryWrapupHook | CommandHook;

export interface HooksConfig {
  session: {
    pre: HookDef[];
    post: HookDef[];
  };
  message: {
    pre: HookDef[];
    post: HookDef[];
  };
}

// ─── Hook Context ───────────────────────────────────────────

export interface SessionHookContext {
  chatId: string;
  chatType: 'p2p' | 'group';
  sessionId?: string;
  transcript: TranscriptEntry[];
  reason?: string;
}

export interface MessageHookContext {
  chatId: string;
  chatType: 'p2p' | 'group';
  role: 'user' | 'assistant';
  content: string;
  imageCount?: number;
}

// ─── Hook Runner ────────────────────────────────────────────

async function runHook(
  hook: HookDef,
  phase: string,
  ctx: SessionHookContext | MessageHookContext,
): Promise<void> {
  switch (hook.type) {
    case 'aria-memory-wrapup': {
      const sessionCtx = ctx as SessionHookContext;
      if (sessionCtx.transcript && sessionCtx.transcript.length > 0) {
        await exportAndRegisterWrapup(
          sessionCtx.chatId,
          sessionCtx.chatType,
          sessionCtx.transcript,
        );
      }
      break;
    }

    case 'command': {
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        HOOK_PHASE: phase,
        HOOK_CHAT_ID: ctx.chatId,
        HOOK_CHAT_TYPE: ctx.chatType,
      };

      if ('role' in ctx) {
        env.HOOK_ROLE = ctx.role;
        env.HOOK_CONTENT = ctx.content;
        if (ctx.imageCount) env.HOOK_IMAGE_COUNT = String(ctx.imageCount);
      }
      if ('sessionId' in ctx && ctx.sessionId) {
        env.HOOK_SESSION_ID = ctx.sessionId;
      }
      if ('reason' in ctx && ctx.reason) {
        env.HOOK_REASON = ctx.reason;
      }
      if ('transcript' in ctx) {
        env.HOOK_TRANSCRIPT_LENGTH = String(ctx.transcript.length);
      }

      const timeout = hook.timeoutMs ?? 10_000;
      try {
        const { stdout, stderr } = await execAsync(hook.command, { env, timeout });
        if (stdout.trim()) {
          logger.info({ phase, command: hook.command, stdout: stdout.trim() }, 'Hook command output');
        }
        if (stderr.trim()) {
          logger.warn({ phase, command: hook.command, stderr: stderr.trim() }, 'Hook command stderr');
        }
      } catch (err) {
        logger.error({ err, phase, command: hook.command }, 'Hook command failed');
      }
      break;
    }

    default:
      logger.warn({ hook }, 'Unknown hook type, skipping');
  }
}

/**
 * Run a list of hooks sequentially.
 */
export async function runHooks(
  hooks: HookDef[],
  phase: string,
  ctx: SessionHookContext | MessageHookContext,
): Promise<void> {
  for (const hook of hooks) {
    try {
      await runHook(hook, phase, ctx);
    } catch (err) {
      logger.error({ err, phase, hookType: hook.type }, 'Hook execution failed');
      // Continue to next hook — one failure shouldn't block others
    }
  }
}
