/**
 * Retry helper for transient Feishu Open API failures.
 *
 * Retries on 5xx responses and common network errors (ECONNRESET, ETIMEDOUT,
 * EAI_AGAIN, etc.) with exponential backoff + jitter. 4xx and other errors
 * are re-thrown immediately.
 */
import { logger } from './logger.js';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  label?: string;
}

const RETRIABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'ERR_BAD_RESPONSE', // axios wraps 5xx as this
]);

function isRetriable(err: any): boolean {
  const status: unknown = err?.response?.status ?? err?.status;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  const code: unknown = err?.code;
  if (typeof code === 'string' && RETRIABLE_CODES.has(code)) return true;
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const label = opts.label ?? 'feishu-api';

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetriable(err)) throw err;
      const delay =
        baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100);
      logger.warn(
        {
          label,
          attempt,
          maxAttempts,
          delayMs: delay,
          status: err?.response?.status ?? err?.status,
          code: err?.code,
        },
        'Feishu API transient failure, retrying',
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
