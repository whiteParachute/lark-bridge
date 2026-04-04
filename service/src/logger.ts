import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.stdout.isTTY
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
