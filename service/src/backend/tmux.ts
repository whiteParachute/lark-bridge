/**
 * tmux 后端。
 *
 * 这个后端不启动 LLM SDK，而是把飞书消息 paste 到一个 tmux pane，并用
 * `capture-pane` 轮询可见输出。它的目标是"接管/交还"已经在 tmux 里的
 * codex / claude code 工作流：lark-bridge 关闭会话时只 detach，不 kill tmux。
 */

import { spawn } from 'node:child_process';
import { logger } from '../logger.js';
import type { Backend, BackendStartOptions, StreamMessage } from './index.js';

interface QueuedInput {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export interface TmuxSessionInfo {
  name: string;
  windows: string;
  attached: string;
  created: string;
}

const MAX_OUTPUT_CHARS = 12_000;

export class TmuxBackend implements Backend {
  private target = '';
  private captureLines = 200;
  private pollIntervalMs = 1000;
  private settleDelayMs = 6000;
  private turnTimeoutMs = 20 * 60 * 1000;
  private observeOnStart = false;
  private outputLoop: Promise<void> | null = null;
  private done = false;
  private currentTurnId = 0;
  private inputQueue: QueuedInput[] = [];
  private waiting: (() => void) | null = null;

  start(
    opts: BackendStartOptions,
    onMessage: (msg: StreamMessage) => void,
  ): void {
    if (!opts.tmux) {
      throw new Error('TmuxBackend requires tmux start options');
    }

    this.target = opts.tmux.target;
    this.captureLines = opts.tmux.captureLines;
    this.pollIntervalMs = opts.tmux.pollIntervalMs;
    this.settleDelayMs = opts.tmux.settleDelayMs;
    this.turnTimeoutMs = opts.tmux.turnTimeoutMs;
    this.observeOnStart = opts.tmux.observeOnStart ?? false;
    this.done = false;
    this.currentTurnId = 0;

    this.outputLoop = (async () => {
      try {
        await ensureTmuxTargetReady(opts.tmux!);
        onMessage({
          type: 'session_init',
          sessionId: this.target,
        });
        if (this.observeOnStart) {
          await this.runObserveTurn(onMessage);
        }
        await this.runLoop(onMessage);
      } catch (err: any) {
        logger.error({ err, target: this.target }, 'tmux backend failed');
        onMessage({
          type: 'error',
          error: err?.message || String(err),
        });
      }
    })();
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
    const turnId = this.currentTurnId;
    const emit = (msg: StreamMessage) => onMessage({ ...msg, turnId });

    if (input.images && input.images.length > 0) {
      logger.warn(
        { count: input.images.length, target: this.target },
        'tmux backend: images are not supported and will be ignored',
      );
    }

    const before = await captureTmuxTarget(this.target, this.captureLines).catch(
      () => '',
    );

    try {
      await pasteToTmux(this.target, input.text);
    } catch (err: any) {
      const error = err?.message || String(err);
      emit({ type: 'turn_complete', text: '', isError: true, error });
      this.currentTurnId++;
      return;
    }

    let latest = before;
    let emitted = '';
    let lastChangedAt = Date.now();
    const deadline = Date.now() + this.turnTimeoutMs;

    while (!this.done && Date.now() < deadline) {
      await sleep(this.pollIntervalMs);
      const nextCapture = await captureTmuxTarget(
        this.target,
        this.captureLines,
      ).catch((err) => {
        logger.debug({ err, target: this.target }, 'tmux capture failed');
        return latest;
      });

      if (nextCapture !== latest) {
        latest = nextCapture;
        lastChangedAt = Date.now();
        const delta = clipOutput(extractPaneDelta(before, latest));
        if (delta && delta !== emitted) {
          emitted = delta;
          emit({ type: 'text_delta', text: emitted });
        }
      }

      if (Date.now() - lastChangedAt >= this.settleDelayMs) break;
    }

    const finalText =
      emitted ||
      `已发送到 tmux \`${this.target}\`，${Math.round(
        this.settleDelayMs / 1000,
      )} 秒内暂无新输出。`;
    emit({ type: 'turn_complete', text: finalText });
    this.currentTurnId++;
  }

  private async runObserveTurn(
    onMessage: (msg: StreamMessage) => void,
  ): Promise<void> {
    const turnId = this.currentTurnId;
    const emit = (msg: StreamMessage) =>
      onMessage({ ...msg, turnId, isObservation: true });

    let latest = await captureTmuxTarget(this.target, this.captureLines).catch(
      (err) => {
        logger.debug({ err, target: this.target }, 'tmux initial capture failed');
        return '';
      },
    );
    let emitted = clipOutput(latest.trim());
    let lastChangedAt = Date.now();
    const deadline = Date.now() + this.turnTimeoutMs;

    if (emitted) {
      emit({ type: 'text_delta', text: emitted });
    }

    while (!this.done && Date.now() < deadline) {
      await sleep(this.pollIntervalMs);
      const nextCapture = await captureTmuxTarget(
        this.target,
        this.captureLines,
      ).catch((err) => {
        logger.debug({ err, target: this.target }, 'tmux observe capture failed');
        return latest;
      });

      if (nextCapture !== latest) {
        latest = nextCapture;
        lastChangedAt = Date.now();
        const nextText = clipOutput(latest.trim());
        if (nextText && nextText !== emitted) {
          emitted = nextText;
          emit({ type: 'text_delta', text: emitted });
        }
      }

      if (Date.now() - lastChangedAt >= this.settleDelayMs) break;
    }

    const finalText =
      emitted ||
      `已接管 tmux \`${this.target}\`，当前 pane 没有可见输出。`;
    emit({ type: 'turn_complete', text: finalText });
    this.currentTurnId++;
  }

  pushMessage(
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): void {
    if (this.done) throw new Error('TmuxBackend already ended');
    this.inputQueue.push({ text, images });
    this.waiting?.();
  }

  getTurnId(): number {
    return this.currentTurnId;
  }

  async interrupt(): Promise<void> {
    // closeSession/provider switch 也会调用 interrupt()。这里故意不向 tmux 发送
    // C-c，避免用户只是从飞书 detach 时误杀电脑端正在跑的 codex/claude。
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async waitForCompletion(): Promise<void> {
    await this.outputLoop;
  }
}

export function isValidTmuxSessionName(name: string): boolean {
  return /^[A-Za-z0-9_.-]{1,80}$/.test(name) && !name.startsWith('-');
}

export async function tmuxTargetExists(target: string): Promise<boolean> {
  try {
    await runTmux(['has-session', '-t', target]);
    return true;
  } catch {
    return false;
  }
}

export async function listTmuxSessions(): Promise<TmuxSessionInfo[]> {
  const out = await runTmux([
    'list-sessions',
    '-F',
    '#S\t#{session_windows}\t#{session_attached}\t#{session_created_string}',
  ]);
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', windows = '', attached = '', created = ''] =
        line.split('\t');
      return { name, windows, attached, created };
    });
}

export async function killTmuxSession(sessionName: string): Promise<void> {
  if (!isValidTmuxSessionName(sessionName)) {
    throw new Error(`invalid tmux session name: ${sessionName}`);
  }
  await runTmux(['kill-session', '-t', sessionName]);
}

export async function captureTmuxTarget(
  target: string,
  lines: number,
): Promise<string> {
  return runTmux([
    'capture-pane',
    '-p',
    '-J',
    '-t',
    target,
    '-S',
    `-${lines}`,
  ]);
}

export async function ensureTmuxTargetReady(
  opts: NonNullable<BackendStartOptions['tmux']>,
): Promise<void> {
  if (await tmuxTargetExists(opts.target)) return;

  if (!opts.create) {
    throw new Error(`tmux target not found: ${opts.target}`);
  }

  if (!isValidTmuxSessionName(opts.create.sessionName)) {
    throw new Error(`invalid tmux session name: ${opts.create.sessionName}`);
  }

  await runTmux([
    'new-session',
    '-d',
    '-s',
    opts.create.sessionName,
    '-c',
    opts.create.cwd,
    opts.create.command,
  ]);
}

async function pasteToTmux(target: string, text: string): Promise<void> {
  const bufferName = `lark_bridge_${Date.now()}`;
  await runTmux(['load-buffer', '-b', bufferName, '-'], text);
  await runTmux(['paste-buffer', '-b', bufferName, '-t', target]);
  await runTmux(['delete-buffer', '-b', bufferName]).catch(() => {});
  await runTmux(['send-keys', '-t', target, 'Enter']);
}

function extractPaneDelta(before: string, after: string): string {
  if (!before.trim()) return after.trim();
  if (after.startsWith(before)) return after.slice(before.length).trim();

  const anchor = before.trimEnd().slice(-1000);
  const idx = anchor.length >= 80 ? after.lastIndexOf(anchor) : -1;
  if (idx >= 0) return after.slice(idx + anchor.length).trim();

  return after.trim();
}

function clipOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(text.length - MAX_OUTPUT_CHARS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runTmux(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `tmux ${args.join(' ')} failed (${code ?? 'signal'}): ${
            stderr || stdout || 'no output'
          }`,
        ),
      );
    });

    child.stdin.on('error', (err: any) => {
      // tmux has-session/capture-pane 这类命令会很快退出并关闭 stdin。调用
      // stdin.end() 撞到 EPIPE 不代表 tmux 命令失败，真正结果以 exit code 为准。
      if (err?.code !== 'EPIPE') {
        logger.debug({ err }, 'tmux stdin error');
      }
    });
    child.stdin.end(input ?? '');
  });
}
