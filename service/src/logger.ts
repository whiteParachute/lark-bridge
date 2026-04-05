import pino from 'pino';

/** Log level can be set via config or env. Call initLogger() after config is loaded. */
let _logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export function initLogger(level: string): void {
  _logger = pino({
    level: process.env.LOG_LEVEL || level || 'info',
  });
}

export { _logger as logger };
