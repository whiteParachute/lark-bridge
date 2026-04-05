/**
 * Memory wrapup integration with aria-memory.
 *
 * On session close: exports transcript and marks it as pending
 * in aria-memory's meta.json. The actual processing happens when
 * aria-memory's SessionStart hook detects the pending wrapup.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger.js';
import { ARIA_MEMORY_DIR, withMetaLock } from './meta-lock.js';

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  imageCount?: number;
}

// ARIA_MEMORY_DIR and metaLock now live in meta-lock.ts (shared with memory-sleep.ts)

/**
 * Export a session transcript and register it as a pending wrapup.
 */
export async function exportAndRegisterWrapup(
  chatId: string,
  chatType: string,
  transcript: TranscriptEntry[],
): Promise<void> {
  if (transcript.length === 0) return;
  if (!existsSync(ARIA_MEMORY_DIR)) {
    logger.warn('aria-memory directory not found, skipping wrapup');
    return;
  }

  try {
    // 1. Format transcript as markdown
    const date = new Date().toISOString().split('T')[0];
    const timestamp = Date.now();
    const filename = `feishu-${chatId.slice(0, 12)}-${timestamp}.md`;
    const transcriptDir = resolve(ARIA_MEMORY_DIR, 'transcripts', date);
    const transcriptPath = resolve(transcriptDir, filename);

    const lines: string[] = [
      `# Feishu conversation (${chatType})`,
      `- Chat ID: ${chatId}`,
      `- Date: ${new Date().toISOString()}`,
      `- Messages: ${transcript.length}`,
      '',
      '---',
      '',
    ];

    for (const entry of transcript) {
      const label = entry.role === 'user' ? '**User**' : '**Assistant**';
      lines.push(`### ${label} (${entry.timestamp})`);
      lines.push('');
      lines.push(entry.content);
      if (entry.imageCount) {
        lines.push(`\n*[${entry.imageCount} image(s) attached]*`);
      }
      lines.push('');
    }

    // 2. Write transcript file
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(transcriptPath, lines.join('\n'), 'utf-8');
    logger.info({ transcriptPath }, 'Transcript exported');

    // 3. Register as pending wrapup in meta.json (serialized via shared mutex)
    await withMetaLock((meta) => {
      const pending: any[] = meta.pendingWrapups as any[] || [];

      if (!pending.some((p: any) => p.transcriptPath === transcriptPath)) {
        pending.push({
          transcriptPath,
          recordedAt: new Date().toISOString(),
          trigger: 'lark_bridge_session_end',
        });
        meta.pendingWrapups = pending;

        logger.info(
          { transcriptPath, pendingCount: pending.length },
          'Registered pending wrapup in aria-memory',
        );
      }
    });
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to export transcript / register wrapup');
  }
}
