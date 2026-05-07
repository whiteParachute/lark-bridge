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

interface TmuxDisplay {
  text: string;
  toolNames: string[];
}

export interface TmuxSessionInfo {
  name: string;
  windows: string;
  attached: string;
  created: string;
}

const MAX_OUTPUT_CHARS = 12_000;
const MAX_RESULT_CHARS = 5000;
const TMUX_SINGLE_LINE_LIMIT = 4000;
const TMUX_SUBMIT_DELAY_MS = 100;
const TMUX_SUBMIT_RETRY_DELAY_MS = 250;
const TMUX_PENDING_CAPTURE_LINES = 30;
const TMUX_PROGRESS_INTERVAL_MS = 2500;
const TMUX_FAST_POLL_WINDOW_MS = 5000;
const TMUX_FAST_POLL_INTERVAL_MS = 250;
const TMUX_READY_SETTLE_MS = 500;
const TMUX_OBSERVE_IDLE_MS = 1000;
const MAX_SUMMARY_TOOLS = 12;
const MAX_HUD_LINES = 12;

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
    let observedOutput = '';
    let lastChangedAt = Date.now();
    let lastProgressAt = 0;
    let readySince: number | null = null;
    const emittedTools = new Set<string>();
    const sentAt = Date.now();
    const deadline = Date.now() + this.turnTimeoutMs;

    emit({ type: 'tool_use_start', toolName: `tmux:${this.target}` });
    emit({
      type: 'thinking_delta',
      text: `tmux \`${this.target}\`：已发送输入，等待 pane 输出稳定。`,
    });

    while (!this.done && Date.now() < deadline) {
      await sleep(this.pollDelay(sentAt));
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
        observedOutput = extractTurnOutput(before, latest, input.text);
        emitToolSummaries(
          summarizeTmuxDisplay(this.target, observedOutput, {
            mode: 'result',
            inputText: input.text,
          }).toolNames,
          emittedTools,
          emit,
        );
        const now = Date.now();
        if (observedOutput && now - lastProgressAt >= TMUX_PROGRESS_INTERVAL_MS) {
          lastProgressAt = now;
          emit({
            type: 'thinking_delta',
            text: `tmux \`${this.target}\`：捕获到新输出，等待 TUI 空闲后返回最终结果。`,
          });
        }
      }

      const now = Date.now();
      const state = getPaneRuntimeState(latest, input.text);
      if (state.busy) {
        readySince = null;
        if (now - lastProgressAt >= TMUX_PROGRESS_INTERVAL_MS) {
          lastProgressAt = now;
          emit({
            type: 'thinking_delta',
            text: `tmux \`${this.target}\`：pane 仍在运行，等待完成。`,
          });
        }
        continue;
      }

      if (state.ready) {
        readySince ??= now;
        if (now - readySince >= TMUX_READY_SETTLE_MS) break;
        continue;
      }

      readySince = null;
      if (now - lastChangedAt >= this.settleDelayMs) break;
    }

    const finalOutput = observedOutput || extractTurnOutput(before, latest, input.text);
    const finalDisplay = finalOutput
      ? summarizeTmuxDisplay(this.target, finalOutput, {
          mode: 'result',
          inputText: input.text,
        })
      : null;
    if (finalDisplay) {
      emitToolSummaries(finalDisplay.toolNames, emittedTools, emit);
    }
    emit({ type: 'tool_use_end', toolName: `tmux:${this.target}` });
    const finalText = finalDisplay
      ? finalDisplay.text
      : `**tmux 已发送**\n目标：\`${this.target}\`\n\n已发送到 tmux，${Math.round(
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
    const emittedTools = new Set<string>();
    let display = summarizeTmuxDisplay(this.target, latest, { mode: 'observe' });
    let emitted = display.text;
    let lastChangedAt = Date.now();
    let lastProgressAt = 0;
    const startedAt = Date.now();
    const deadline = Date.now() + this.turnTimeoutMs;

    if (emitted) {
      emitToolSummaries(display.toolNames, emittedTools, emit);
      emit({ type: 'text_delta', text: emitted });
    }

    while (!this.done && Date.now() < deadline) {
      const initialState = getPaneRuntimeState(latest);
      if (initialState.ready && !initialState.busy) break;

      await sleep(this.pollDelay(startedAt));
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
        display = summarizeTmuxDisplay(this.target, latest, { mode: 'observe' });
        emitToolSummaries(display.toolNames, emittedTools, emit);
        const nextText = display.text;
        if (nextText && nextText !== emitted) {
          emitted = nextText;
          emit({ type: 'text_delta', text: emitted });
        }
      }

      const now = Date.now();
      const state = getPaneRuntimeState(latest);
      if (state.ready && !state.busy) break;
      if (state.busy) {
        if (now - lastProgressAt >= TMUX_PROGRESS_INTERVAL_MS) {
          lastProgressAt = now;
          emit({
            type: 'thinking_delta',
            text: `tmux \`${this.target}\`：当前 pane 仍在运行，接管输入会等待它完成。`,
          });
        }
        continue;
      }

      if (now - lastChangedAt >= Math.min(this.settleDelayMs, TMUX_OBSERVE_IDLE_MS)) {
        break;
      }
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

  private pollDelay(referenceTime: number): number {
    if (Date.now() - referenceTime <= TMUX_FAST_POLL_WINDOW_MS) {
      return Math.min(this.pollIntervalMs, TMUX_FAST_POLL_INTERVAL_MS);
    }
    return this.pollIntervalMs;
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
  const normalizedText = normalizeTmuxInput(text);
  if (!normalizedText) return;

  if (!normalizedText.includes('\n') && normalizedText.length <= TMUX_SINGLE_LINE_LIMIT) {
    await runTmux(['send-keys', '-t', target, '-l', normalizedText]);
    await submitTmuxInput(target, normalizedText);
    return;
  }

  const bufferName = `lark_bridge_${Date.now()}`;
  await runTmux(['load-buffer', '-b', bufferName, '-'], normalizedText);
  await runTmux(['paste-buffer', '-b', bufferName, '-t', target]);
  await runTmux(['delete-buffer', '-b', bufferName]).catch(() => {});
  await submitTmuxInput(target);
}

function normalizeTmuxInput(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '');
}

async function submitTmuxInput(
  target: string,
  pendingText?: string,
): Promise<void> {
  await sleep(TMUX_SUBMIT_DELAY_MS);
  await runTmux(['send-keys', '-t', target, 'Enter']);

  if (!pendingText || pendingText.length > 500) return;

  await sleep(TMUX_SUBMIT_RETRY_DELAY_MS);
  const capture = await captureTmuxTarget(target, TMUX_PENDING_CAPTURE_LINES).catch(
    () => '',
  );
  if (!isInputStillPending(capture, pendingText)) return;

  logger.warn(
    { target, chars: pendingText.length },
    'tmux input still pending after submit; retrying Enter',
  );
  await runTmux(['send-keys', '-t', target, 'Enter']);
}

function isInputStillPending(capture: string, pendingText: string): boolean {
  const firstLine = pendingText.split('\n')[0]?.trim();
  if (!firstLine) return false;

  return capture
    .split('\n')
    .slice(-8)
    .some((line) => line.trim() === `› ${firstLine}`);
}

function emitToolSummaries(
  toolNames: string[],
  emittedTools: Set<string>,
  emit: (msg: StreamMessage) => void,
): void {
  for (const toolName of toolNames.slice(0, MAX_SUMMARY_TOOLS)) {
    if (emittedTools.has(toolName)) continue;
    emittedTools.add(toolName);
    emit({ type: 'tool_use_start', toolName });
    emit({ type: 'tool_use_end', toolName });
  }
}

function summarizeTmuxDisplay(
  target: string,
  output: string,
  opts: { mode: 'observe' | 'result'; inputText?: string },
): TmuxDisplay {
  const redactedOutput = redactTmuxOutput(output.trim());
  const claudeSummary = summarizeClaudeTui(target, redactedOutput, opts);
  if (claudeSummary) return claudeSummary;

  if (opts.mode === 'observe') {
    return formatGenericObservation(target, redactedOutput);
  }

  return formatGenericResult(target, opts.inputText ?? '', redactedOutput);
}

function formatGenericResult(
  target: string,
  inputText: string,
  output: string,
): TmuxDisplay {
  const input = redactTmuxOutput(normalizeTmuxInput(inputText).trim());
  const result = clipResult(output);
  const lines = [
    '**tmux 返回结果**',
    `目标：\`${target}\``,
    input ? `输入：\`${escapeInlineCode(input)}\`` : '',
    '',
    '```text',
    result,
    '```',
  ];
  return {
    text: lines.filter((line, idx) => line || idx === 3).join('\n'),
    toolNames: [],
  };
}

function formatGenericObservation(target: string, output: string): TmuxDisplay {
  const clean = clipResult(stripTrailingComposer(output).trim());
  const lines = [
    '**tmux 接管状态**',
    `目标：\`${target}\``,
    '',
    clean ? '```text' : '',
    clean,
    clean ? '```' : '当前 pane 没有可见输出。',
  ];
  return {
    text: lines.filter(Boolean).join('\n'),
    toolNames: [],
  };
}

function summarizeClaudeTui(
  target: string,
  output: string,
  opts: { mode: 'observe' | 'result'; inputText?: string },
): TmuxDisplay | null {
  if (!looksLikeClaudeTui(output)) return null;

  const lines = output.split('\n');
  const hud = extractClaudeHud(lines);
  const toolNames = extractClaudeToolNames(lines, hud.toolCountLines);
  const title = opts.mode === 'observe' ? '**tmux 接管状态**' : '**tmux 返回结果**';
  const body: string[] = [title, `目标：\`${target}\``];

  if (opts.mode === 'result' && opts.inputText) {
    const input = normalizeTmuxInput(opts.inputText).trim();
    if (input) body.push(`输入：\`${escapeInlineCode(redactTmuxOutput(input))}\``);
  }

  body.push('');
  body.push('**Claude HUD**');
  if (hud.prompt) body.push(`- 当前输入：\`${escapeInlineCode(hud.prompt)}\``);
  for (const line of hud.summaryLines) {
    body.push(`- ${line}`);
  }
  if (hud.summaryLines.length === 0 && !hud.prompt) {
    body.push('- 未捕获到底部 HUD 摘要。');
  }

  if (toolNames.length > 0) {
    body.push('');
    body.push('**工具概览**');
    for (const tool of toolNames.slice(0, MAX_SUMMARY_TOOLS)) {
      body.push(`- ${tool}`);
    }
    if (toolNames.length > MAX_SUMMARY_TOOLS) {
      body.push(`- 另有 ${toolNames.length - MAX_SUMMARY_TOOLS} 项工具调用已省略`);
    }
  }

  body.push('');
  body.push('> 已隐藏 Claude TUI 中的大段 Edit / diff 内容；执行中工具会通过临时进度卡展示。');

  return {
    text: body.join('\n'),
    toolNames,
  };
}

function looksLikeClaudeTui(output: string): boolean {
  return (
    /\[[^\]\n]*(?:Opus|Sonnet|Haiku|Claude)[^\]\n]*\]/i.test(output) ||
    /\bUsage\b.*\bWeekly\b/s.test(output) ||
    /⏵⏵\s+auto mode/i.test(output) ||
    /(?:^|\n)\s*●\s+(?:Update|Bash|Read|Write|Edit|Search|Grep|Glob|Todo|Explore|Listed|Wrote)\b/.test(output)
  );
}

function extractClaudeHud(lines: string[]): {
  prompt: string;
  summaryLines: string[];
  toolCountLines: string[];
} {
  const prompt = findLastPrompt(lines);
  const summaryLines: string[] = [];
  const toolCountLines: string[] = [];
  const tail = lines.slice(Math.max(0, lines.length - 40));

  for (const rawLine of tail) {
    const line = normalizeHudLine(rawLine);
    if (!line) continue;

    if (
      /^\[[^\]]+\]/.test(line) ||
      /\bgit:\([^)]+\)/.test(line) ||
      /\|\s*\d+\s+hooks\b/.test(line) ||
      /^Usage\b/i.test(line) ||
      /^Weekly\b/i.test(line) ||
      /^⏱/.test(line) ||
      /auto mode/i.test(line) ||
      /All todos complete/i.test(line)
    ) {
      summaryLines.push(line);
      continue;
    }

    if (/^[✓✗]\s+/.test(line)) {
      toolCountLines.push(line);
      summaryLines.push(line);
    }
  }

  return {
    prompt,
    summaryLines: uniqueStrings(summaryLines).slice(0, MAX_HUD_LINES),
    toolCountLines,
  };
}

function findLastPrompt(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].trim().match(/^[❯›]\s+(.+)$/);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function normalizeHudLine(line: string): string {
  return line
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractClaudeToolNames(
  lines: string[],
  toolCountLines: string[],
): string[] {
  const countedNames: string[] = [];

  for (const line of toolCountLines) {
    const clean = normalizeHudLine(line).replace(/^[✓✗]\s+/, '');
    for (const part of clean.split('|')) {
      const token = part.trim().replace(/^[✓✗]\s+/, '');
      if (token) countedNames.push(token);
    }
  }
  if (countedNames.length > 0) {
    return uniqueStrings(countedNames).slice(0, MAX_SUMMARY_TOOLS * 2);
  }

  const names: string[] = [];
  for (const rawLine of lines) {
    const line = normalizeHudLine(rawLine);
    const bullet = line.match(/^●\s+([A-Za-z][\w:-]*)(?:\(([^)]*)\)|:|\b)/);
    if (!bullet) continue;
    if (!isKnownClaudeToolHeader(bullet[1])) continue;
    names.push(normalizeClaudeToolName(bullet[1], bullet[2]));
  }

  return uniqueStrings(names.filter(Boolean)).slice(0, MAX_SUMMARY_TOOLS * 2);
}

function isKnownClaudeToolHeader(name: string): boolean {
  return new Set([
    'Bash',
    'Edit',
    'Glob',
    'Grep',
    'LS',
    'List',
    'Listed',
    'Read',
    'Search',
    'Todo',
    'TodoWrite',
    'Update',
    'Write',
    'Wrote',
  ]).has(name);
}

function normalizeClaudeToolName(name: string, arg?: string): string {
  const mapped =
    name === 'Update'
      ? 'Edit'
      : name === 'Wrote'
        ? 'Write'
        : name === 'Listed' || name === 'List'
          ? 'LS'
          : name;
  if (!arg) return mapped;

  const path = arg.split(',')[0]?.trim();
  if (!path || mapped === 'Bash') return mapped;
  return `${mapped} ${path}`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function extractTurnOutput(before: string, after: string, inputText: string): string {
  const cleanAfter = stripTrailingComposer(after).trim();
  if (!cleanAfter) return '';

  const markerOutput = extractFromInputMarker(cleanAfter, inputText);
  if (markerOutput) return markerOutput;

  return stripTrailingComposer(extractPaneDelta(before, cleanAfter)).trim();
}

function extractFromInputMarker(capture: string, inputText: string): string {
  const normalizedInput = normalizeTmuxInput(inputText).trim();
  const firstLine = normalizedInput.split('\n').find((line) => line.trim())?.trim();
  if (!firstLine) return '';

  const lines = capture.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === firstLine || trimmed === `› ${firstLine}`) {
      return lines.slice(i).join('\n').trim();
    }
  }
  return '';
}

function getPaneRuntimeState(
  capture: string,
  inputText?: string,
): { ready: boolean; busy: boolean } {
  const lines = capture.split('\n');
  const composerStart = findTrailingComposerStart(lines);
  const ready = composerStart >= 0;
  const relevantText = inputText
    ? relevantSliceAfterInput(lines, inputText).join('\n')
    : lines.slice(Math.max(0, lines.length - 30)).join('\n');
  const busy = isPaneBusy(relevantText);
  return { ready: ready && !busy, busy };
}

function relevantSliceAfterInput(lines: string[], inputText: string): string[] {
  const normalizedInput = normalizeTmuxInput(inputText).trim();
  const firstLine = normalizedInput.split('\n').find((line) => line.trim())?.trim();
  if (!firstLine) return lines.slice(Math.max(0, lines.length - 30));

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === firstLine || trimmed === `› ${firstLine}`) {
      return lines.slice(i);
    }
  }

  return lines.slice(Math.max(0, lines.length - 30));
}

function isPaneBusy(text: string): boolean {
  return (
    /\bWorking\s*\(/i.test(text) ||
    /\bRunning\s*\(/i.test(text) ||
    /\bThinking\s*\(/i.test(text) ||
    /esc to interrupt/i.test(text) ||
    /Starting MCP servers/i.test(text) ||
    /Booting MCP server/i.test(text)
  );
}

function stripTrailingComposer(text: string): string {
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  if (end <= 0) return '';

  const composerStart = findTrailingComposerStart(lines.slice(0, end));
  if (composerStart < 0) {
    return lines.slice(0, end).join('\n');
  }

  return lines.slice(0, composerStart).join('\n').trimEnd();
}

function findTrailingComposerStart(lines: string[]): number {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  if (end <= 0) return -1;

  const statusIdx = end - 1;
  if (!isComposerStatusLine(lines[statusIdx])) return -1;

  let promptIdx = statusIdx - 1;
  while (promptIdx >= 0 && !lines[promptIdx].trim()) promptIdx--;
  if (promptIdx >= 0 && lines[promptIdx].trim().startsWith('› ')) {
    return promptIdx;
  }

  return -1;
}

function isComposerStatusLine(line: string): boolean {
  return /\b(?:gpt|claude|opus|sonnet|haiku)[\w.-]*\b/i.test(line) && line.includes(' · /');
}

function redactTmuxOutput(text: string): string {
  return text.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    '[redacted-email]',
  );
}

function escapeInlineCode(text: string): string {
  return text.replace(/`/g, '\\`').replace(/\n+/g, ' / ');
}

function clipResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `…（已截断，仅显示最近 ${MAX_RESULT_CHARS} 字符）\n${text.slice(
    text.length - MAX_RESULT_CHARS,
  )}`;
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
