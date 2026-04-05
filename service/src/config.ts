import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const HookDefSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('aria-memory-wrapup'),
  }),
  z.object({
    type: z.literal('command'),
    command: z.string().min(1),
    timeoutMs: z.number().optional(),
  }),
]);

const HooksSchema = z
  .object({
    session: z
      .object({
        pre: z.array(HookDefSchema).default([]),
        post: z.array(HookDefSchema).default([{ type: 'aria-memory-wrapup' as const }]),
      })
      .default({
        pre: [],
        post: [{ type: 'aria-memory-wrapup' as const }],
      }),
    message: z
      .object({
        pre: z.array(HookDefSchema).default([]),
        post: z.array(HookDefSchema).default([]),
      })
      .default({ pre: [], post: [] }),
  })
  .default({
    session: { pre: [], post: [{ type: 'aria-memory-wrapup' as const }] },
    message: { pre: [], post: [] },
  });

const ConfigSchema = z.object({
  feishu: z.object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    /** Allowed sender open_ids. Empty = allow all (DANGEROUS). */
    allowedSenders: z.array(z.string()).default([]),
    /** Allowed chat_ids. Empty = allow all (DANGEROUS). */
    allowedChats: z.array(z.string()).default([]),
  }),
  claude: z
    .object({
      model: z.string().default('sonnet'),
      workspaceRoot: z.string().default('~/workspace/lark-bridge'),
      additionalDirectories: z.array(z.string()).default([]),
      /** Permission mode for Claude sessions. Default: plan (safer). */
      permissionMode: z
        .enum(['bypassPermissions', 'plan', 'default'])
        .default('plan'),
    })
    .default({
      model: 'sonnet',
      workspaceRoot: '~/workspace/lark-bridge',
      additionalDirectories: [],
      permissionMode: 'plan',
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
  hooks: HooksSchema,
  daemon: z
    .object({
      /** How to run the daemon: "nohup" (default) or "service" (systemd/launchd). */
      mode: z.enum(['nohup', 'service']).default('nohup'),
      /** Auto-start daemon on boot. Only effective when mode is "service". */
      autoStart: z.boolean().default(false),
    })
    .default({ mode: 'nohup', autoStart: false }),
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
    resolve(homedir(), '.lark-bridge', 'config.json');

  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\nRun /feishu-setup to create it.`,
    );
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  const config = ConfigSchema.parse(raw);

  // Warn if no allowlist configured
  if (
    config.feishu.allowedSenders.length === 0 &&
    config.feishu.allowedChats.length === 0
  ) {
    console.warn(
      '⚠️  WARNING: No allowedSenders or allowedChats configured. ALL Feishu users can interact with Claude!',
    );
  }

  config.claude.workspaceRoot = expandHome(config.claude.workspaceRoot);
  config.claude.additionalDirectories =
    config.claude.additionalDirectories.map(expandHome);

  return config;
}
