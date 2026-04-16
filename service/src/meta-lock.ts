/**
 * Shared mutex and atomic write helper for aria-memory meta.json.
 *
 * Both memory-wrapup.ts and memory-sleep.ts modify meta.json.
 * This module serializes all writes through a single promise chain
 * and uses tmp+rename for crash safety.
 *
 * Paths are initialized at startup via initMemoryPaths(). Before that,
 * ARIA_MEMORY_DIR and META_PATH are empty strings — callers that run
 * before init (shouldn't happen) will fail loudly on existsSync('').
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { logger } from './logger.js';

export let ARIA_MEMORY_DIR = '';
export let META_PATH = '';

/**
 * Set the aria-memory directory paths. Must be called once at startup
 * (from index.ts) before any memory operations run.
 */
export function initMemoryPaths(memoryDir: string): void {
  ARIA_MEMORY_DIR = memoryDir;
  META_PATH = resolve(memoryDir, 'meta.json');
}

/** Promise-chain mutex — serializes all meta.json modifications in-process. */
let metaLock: Promise<void> = Promise.resolve();

/**
 * Read-modify-write meta.json under mutex with atomic tmp+rename.
 * The mutator receives the parsed object and should modify it in place.
 */
export function withMetaLock(mutator: (meta: Record<string, unknown>) => void | Promise<void>): Promise<void> {
  metaLock = metaLock.then(async () => {
    try {
      if (!existsSync(META_PATH)) {
        logger.warn('meta.json not found, skipping meta write');
        return;
      }
      const meta = JSON.parse(await readFile(META_PATH, 'utf-8'));
      await mutator(meta);

      const tmpPath = resolve(dirname(META_PATH), `.meta.json.tmp.${Date.now()}`);
      await writeFile(tmpPath, JSON.stringify(meta, null, 2), 'utf-8');
      await rename(tmpPath, META_PATH);
    } catch (err) {
      logger.error({ err }, 'meta.json locked write failed');
    }
  });
  return metaLock;
}
