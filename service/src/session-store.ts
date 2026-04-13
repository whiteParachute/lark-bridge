/**
 * Session Store — persists chatId → sessionId mappings for session resume.
 *
 * Design:
 * - In-memory cache + debounced disk writes (non-blocking)
 * - Atomic writes (tmp + rename) to prevent corruption on crash
 * - TTL-based expiry, pruned on load
 * - Max 1000 entries to bound growth
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger.js';

interface SessionStoreEntry {
  sessionId: string;
  savedAt: string; // ISO timestamp
  chatType: 'p2p' | 'group';
}

type SessionStoreData = Record<string, SessionStoreEntry>;

const DEFAULT_PATH = resolve(homedir(), '.lark-bridge', 'session-store.json');
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ENTRIES = 1000;
const DEBOUNCE_MS = 100;

export class SessionStore {
  private data: SessionStoreData;
  private readonly filePath: string;
  private readonly maxAgeMs: number;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath?: string, maxAgeMs?: number) {
    this.filePath = filePath ?? DEFAULT_PATH;
    this.maxAgeMs = maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.data = this.load();
  }

  /** Get sessionId for a chatId. Returns undefined if missing or expired. */
  get(chatId: string): string | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;

    const age = Date.now() - new Date(entry.savedAt).getTime();
    if (age > this.maxAgeMs) {
      delete this.data[chatId];
      this.scheduleSave();
      return undefined;
    }

    return entry.sessionId;
  }

  /** Save or update the mapping for a chatId. */
  set(chatId: string, sessionId: string, chatType: 'p2p' | 'group'): void {
    this.data[chatId] = {
      sessionId,
      savedAt: new Date().toISOString(),
      chatType,
    };
    this.enforceMaxEntries();
    this.scheduleSave();
  }

  /** Remove mapping for a chatId (e.g. on resume failure). */
  delete(chatId: string): void {
    if (chatId in this.data) {
      delete this.data[chatId];
      this.scheduleSave();
    }
  }

  // ─── Private ─────────────────────────────────────────────────

  private load(): SessionStoreData {
    try {
      if (!existsSync(this.filePath)) return {};
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      // Prune expired entries on load
      const now = Date.now();
      const result: SessionStoreData = {};
      for (const [chatId, entry] of Object.entries(raw as SessionStoreData)) {
        if (!entry?.sessionId || !entry?.savedAt) continue;
        const age = now - new Date(entry.savedAt).getTime();
        if (age <= this.maxAgeMs) {
          result[chatId] = entry;
        }
      }
      logger.info(
        { loaded: Object.keys(result).length, path: this.filePath },
        'Session store loaded',
      );
      return result;
    } catch (err) {
      logger.warn({ err, path: this.filePath }, 'Failed to load session store, starting fresh');
      return {};
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, DEBOUNCE_MS);
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      logger.error({ err, path: this.filePath }, 'Failed to save session store');
      // Non-fatal: in-memory map still works for current daemon lifetime
    }
  }

  private enforceMaxEntries(): void {
    const keys = Object.keys(this.data);
    if (keys.length <= MAX_ENTRIES) return;

    // Sort by savedAt ascending, remove oldest
    const sorted = keys.sort(
      (a, b) =>
        new Date(this.data[a].savedAt).getTime() -
        new Date(this.data[b].savedAt).getTime(),
    );
    const toRemove = sorted.slice(0, keys.length - MAX_ENTRIES);
    for (const key of toRemove) {
      delete this.data[key];
    }
  }
}
