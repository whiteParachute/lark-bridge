/**
 * 持久化每个 chat 的偏好（目前仅"默认后端"）到 ~/.lark-bridge/chat-state.json。
 *
 * 用途：用户用 `/provider codex` 切到 codex 后，daemon 重启不应丢失这个选择。
 * 文件很小（每个 chat 一条小记录），写入用 tmp+rename 保证原子性。
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger.js';
import type { BackendKind } from './backend/index.js';

interface ChatStateEntry {
  backend: BackendKind;
  updatedAt: string; // ISO timestamp
}

interface ChatStateFile {
  version: 1;
  chats: Record<string, ChatStateEntry>;
}

const STATE_PATH = resolve(homedir(), '.lark-bridge', 'chat-state.json');

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
        this.state = { version: 1, chats: parsed.chats };
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
    this.state.chats[chatId] = {
      backend,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
  }

  /** 同步写入；调用频次极低（只在 /provider 时触发），开销可忽略。 */
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
