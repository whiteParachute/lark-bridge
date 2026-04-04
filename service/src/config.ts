import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const ConfigSchema = z.object({
  feishu: z.object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
  }),
  claude: z
    .object({
      model: z.string().default('sonnet'),
      workspaceRoot: z.string().default('~/workspace/feishu-bridge'),
      additionalDirectories: z.array(z.string()).default([]),
    })
    .default({
      model: 'sonnet',
      workspaceRoot: '~/workspace/feishu-bridge',
      additionalDirectories: [],
    }),
  session: z
    .object({
      idleTimeoutMs: z.number().default(30 * 60 * 1000),
      maxDurationMs: z.number().default(4 * 60 * 60 * 1000),
    })
    .default({
      idleTimeoutMs: 30 * 60 * 1000,
      maxDurationMs: 4 * 60 * 60 * 1000,
    }),
  log: z
    .object({
      level: z.string().default('info'),
    })
    .default({ level: 'info' }),
});

export type BridgeConfig = z.infer<typeof ConfigSchema>;

function expandHome(p: string): string {
  return p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p);
}

export function loadConfig(): BridgeConfig {
  const configPath =
    process.env.FEISHU_BRIDGE_CONFIG ||
    resolve(homedir(), '.feishu-bridge', 'config.json');

  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\nRun /feishu-setup to create it.`,
    );
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  const config = ConfigSchema.parse(raw);

  config.claude.workspaceRoot = expandHome(config.claude.workspaceRoot);
  config.claude.additionalDirectories =
    config.claude.additionalDirectories.map(expandHome);

  return config;
}
