/**
 * 持久化每个 chat 的偏好到 ~/.lark-bridge/chat-state.json。
 *
 * 当前保存两类偏好：
 * - 默认后端：用户用 `/provider codex` 切到 codex 后，daemon 重启不应丢失。
 * - 每后端模型覆盖：同一个 chat 可分别记住 claude/codex 的 `/model` 选择。
 * - tmux 接管目标：用户用 `/tmux attach/new` 后，daemon 重启仍能回到同一 pane。
 *
 * 文件很小（每个 chat 一条小记录），写入用 tmp+rename 保证原子性。
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger.js';
import type { BackendKind, DirectBackendKind } from './backend/index.js';

type ChatModelMap = Partial<Record<DirectBackendKind, string>>;

export interface ChatTmuxTarget {
  target: string;
  create?: boolean;
  sessionName?: string;
  provider?: DirectBackendKind;
  cwd?: string;
}

interface ChatStateEntry {
  backend?: BackendKind;
  models?: ChatModelMap;
  tmux?: ChatTmuxTarget;
  updatedAt: string; // ISO timestamp
}

interface ChatStateFile {
  version: 1;
  chats: Record<string, ChatStateEntry>;
}

const STATE_PATH = resolve(homedir(), '.lark-bridge', 'chat-state.json');
const VALID_BACKENDS = new Set<BackendKind>(['claude', 'codex', 'tmux']);
const DIRECT_BACKENDS = new Set<DirectBackendKind>(['claude', 'codex']);

export class ChatStateStore {
  private state: ChatStateFile = { version: 1, chats: {} };

  /** 同步加载持久化文件；缺失/损坏均回退到空状态，不抛错。 */
  load(): void {
    if (!existsSync(STATE_PATH)) {
      logger.debug({ path: STATE_PATH }, 'chat-state file not found, starting empty');
      return;
    }
    try {
      const raw = readFileSync(STATE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.chats) {
        this.state = { version: 1, chats: this.normalizeChats(parsed.chats) };
        logger.info(
          { chatCount: Object.keys(this.state.chats).length },
          'chat-state loaded',
        );
      }
    } catch (err) {
      logger.warn({ err, path: STATE_PATH }, 'chat-state parse failed, starting empty');
    }
  }

  getBackend(chatId: string): BackendKind | null {
    return this.state.chats[chatId]?.backend ?? null;
  }

  setBackend(chatId: string, backend: BackendKind): void {
    const entry = this.state.chats[chatId];
    this.state.chats[chatId] = {
      ...entry,
      backend,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
  }

  clearBackend(chatId: string): void {
    const entry = this.state.chats[chatId];
    if (!entry?.backend) return;
    delete entry.backend;
    entry.updatedAt = new Date().toISOString();
    if (!entry.models && !entry.tmux) {
      delete this.state.chats[chatId];
    }
    this.persist();
  }

  getModel(chatId: string, backend: DirectBackendKind): string | null {
    return this.state.chats[chatId]?.models?.[backend] ?? null;
  }

  setModel(chatId: string, backend: DirectBackendKind, model: string): void {
    const entry = this.state.chats[chatId];
    this.state.chats[chatId] = {
      ...entry,
      models: {
        ...entry?.models,
        [backend]: model,
      },
      updatedAt: new Date().toISOString(),
    };
    this.persist();
  }

  clearModel(chatId: string, backend: DirectBackendKind): void {
    const entry = this.state.chats[chatId];
    if (!entry?.models?.[backend]) return;

    const models = { ...entry.models };
    delete models[backend];

    if (Object.keys(models).length === 0) {
      delete entry.models;
    } else {
      entry.models = models;
    }
    entry.updatedAt = new Date().toISOString();

    if (!entry.backend && !entry.models && !entry.tmux) {
      delete this.state.chats[chatId];
    }
    this.persist();
  }

  getTmux(chatId: string): ChatTmuxTarget | null {
    return this.state.chats[chatId]?.tmux ?? null;
  }

  setTmux(chatId: string, target: ChatTmuxTarget): void {
    const entry = this.state.chats[chatId];
    this.state.chats[chatId] = {
      ...entry,
      tmux: target,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
  }

  clearTmux(chatId: string): void {
    const entry = this.state.chats[chatId];
    if (!entry?.tmux) return;
    delete entry.tmux;
    if (entry.backend === 'tmux') delete entry.backend;
    entry.updatedAt = new Date().toISOString();
    if (!entry.backend && !entry.models && !entry.tmux) {
      delete this.state.chats[chatId];
    }
    this.persist();
  }

  private normalizeChats(rawChats: unknown): Record<string, ChatStateEntry> {
    if (!rawChats || typeof rawChats !== 'object') return {};

    const chats: Record<string, ChatStateEntry> = {};
    for (const [chatId, rawEntry] of Object.entries(rawChats)) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;
      const entryObj = rawEntry as Record<string, unknown>;
      const entry: ChatStateEntry = {
        updatedAt:
          typeof entryObj.updatedAt === 'string'
            ? entryObj.updatedAt
            : new Date().toISOString(),
      };

      if (
        typeof entryObj.backend === 'string' &&
        VALID_BACKENDS.has(entryObj.backend as BackendKind)
      ) {
        entry.backend = entryObj.backend as BackendKind;
      }

      if (entryObj.models && typeof entryObj.models === 'object') {
        const models: ChatModelMap = {};
        for (const [backend, model] of Object.entries(
          entryObj.models as Record<string, unknown>,
        )) {
          if (
            DIRECT_BACKENDS.has(backend as DirectBackendKind) &&
            typeof model === 'string' &&
            model.trim()
          ) {
            models[backend as DirectBackendKind] = model.trim();
          }
        }
        if (Object.keys(models).length > 0) entry.models = models;
      }

      if (entryObj.tmux && typeof entryObj.tmux === 'object') {
        const rawTmux = entryObj.tmux as Record<string, unknown>;
        if (typeof rawTmux.target === 'string' && rawTmux.target.trim()) {
          const tmux: ChatTmuxTarget = {
            target: rawTmux.target.trim(),
          };
          if (typeof rawTmux.create === 'boolean') tmux.create = rawTmux.create;
          if (
            typeof rawTmux.sessionName === 'string' &&
            rawTmux.sessionName.trim()
          ) {
            tmux.sessionName = rawTmux.sessionName.trim();
          }
          if (
            typeof rawTmux.provider === 'string' &&
            DIRECT_BACKENDS.has(rawTmux.provider as DirectBackendKind)
          ) {
            tmux.provider = rawTmux.provider as DirectBackendKind;
          }
          if (typeof rawTmux.cwd === 'string' && rawTmux.cwd.trim()) {
            tmux.cwd = rawTmux.cwd.trim();
          }
          entry.tmux = tmux;
        }
      }

      if (entry.backend || entry.models || entry.tmux) chats[chatId] = entry;
    }
    return chats;
  }

  /** 同步写入；调用频次极低（只在 bot 命令改偏好时触发），开销可忽略。 */
  private persist(): void {
    try {
      const tmp = resolve(dirname(STATE_PATH), `.chat-state.tmp.${Date.now()}`);
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
      renameSync(tmp, STATE_PATH);
    } catch (err) {
      logger.error({ err, path: STATE_PATH }, 'chat-state persist failed');
    }
  }
}
