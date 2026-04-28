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
        post: z.array(HookDefSchema).default([]),
      })
      .default({ pre: [], post: [] }),
    message: z
      .object({
        pre: z.array(HookDefSchema).default([]),
        post: z.array(HookDefSchema).default([]),
      })
      .default({ pre: [], post: [] }),
  })
  .default({
    session: { pre: [], post: [] },
    message: { pre: [], post: [] },
  });

const ConfigSchema = z.object({
  /**
   * aria-memory 集成的最小必需配置 —— 仅 vault 路径。
   *
   * 是否集成由 `hooks.session.post` 是否包含 `{ type: 'aria-memory-wrapup' }`
   * 决定，不再用单独的开关。后者出现 = opt-in，daemon 在每次 feishu 会话
   * 关闭时把真实 SDK transcript 路径登记到 `<memoryDir>/meta.json.pendingWrapups`。
   *
   * 实际的 wrapup 处理 + global_sleep 由 primary host 上的 claude/codex CLI
   * 启动时的 aria-memory SessionStart hook 负责，daemon 这边不做。
   *
   * 如果 vault 目录不存在，wrapup hook 会静默 skip（debug log），不打扰用户。
   */
  // 兼容旧 schema：用 looseObject 吃掉 `enabled` / `variant` 等已废弃字段
  // 而不报错（已废弃字段在 warnDeprecatedFields 里 console.warn 一次）。
  ariaMemory: z
    .looseObject({
      /** Path to the aria-memory vault directory. Default: ~/.aria-memory */
      memoryDir: z.string().default('~/.aria-memory'),
    })
    .default({ memoryDir: '~/.aria-memory' }),
  feishu: z.object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    /** Allowed sender open_ids. Empty = allow all (DANGEROUS). */
    allowedSenders: z.array(z.string()).default([]),
    /** Allowed chat_ids. Empty = allow all (DANGEROUS). */
    allowedChats: z.array(z.string()).default([]),
  }),
  /**
   * 全局默认后端。新 chat（未在 chat-state.json 持久化过）使用此后端。
   * `/provider <kind>` 切换后会写到 chat-state.json，每个 chat 独立持久。
   */
  defaultBackend: z.enum(['claude', 'codex']).default('claude'),
  claude: z
    .object({
      model: z.string().default('sonnet'),
      workspaceRoot: z.string().default('~/workspace/lark-bridge'),
      additionalDirectories: z.array(z.string()).default([]),
      /** Allow Claude to access all directories under $HOME. Default: false. */
      allowAllDirectories: z.boolean().default(false),
      /** Permission mode for Claude sessions. Default: plan (safer). */
      permissionMode: z
        .enum(['bypassPermissions', 'plan', 'default'])
        .default('plan'),
    })
    .default({
      model: 'sonnet',
      workspaceRoot: '~/workspace/lark-bridge',
      additionalDirectories: [],
      allowAllDirectories: false,
      permissionMode: 'plan',
    }),
  /**
   * Codex 后端配置。workspaceRoot 复用 `claude.workspaceRoot`（两个后端共享
   * 每 chat 的工作目录），故此处只需 codex 特有字段。
   * 鉴权：通过 codex CLI 自身的会话状态（`codex login` 或 CODEX_API_KEY 环境
   * 变量）传递，不在 lark-bridge 配置里管理。
   */
  codex: z
    .object({
      /** Codex 模型名（如 'gpt-5-codex'）；省略则使用 codex SDK 默认值。 */
      model: z.string().optional(),
    })
    .default({}),
  session: z
    .object({
      idleTimeoutMs: z.number().default(30 * 60 * 1000),
      maxDurationMs: z.number().default(4 * 60 * 60 * 1000),
    })
    .default({
      idleTimeoutMs: 30 * 60 * 1000,
      maxDurationMs: 4 * 60 * 60 * 1000,
    }),
  wsWatchdog: z
    .object({
      /** Enable automatic reconnect when WS fails consecutively. Default: true. */
      enabled: z.boolean().default(true),
      /**
       * Trigger reconnect after this many consecutive WS connection failures.
       * The Lark SDK logs "[ws] timeout" or "unable to connect" on each attempt.
       * Default: 5.
       */
      maxConsecutiveFailures: z.number().min(2).default(5),
      /**
       * Minimum wait between reconnect attempts, in ms. Prevents tight
       * reconnect loops when the network is down. Default: 60 seconds.
       */
      reconnectCooldownMs: z.number().min(10_000).default(60_000),
      /**
       * Safety-net: if no message has been received for this long AND no
       * reconnect failures have been counted (SDK silently died), force a
       * reconnect. Default: 30 minutes. 0 = disabled.
       */
      silenceTimeoutMs: z.number().min(0).default(30 * 60 * 1000),
    })
    .default({
      enabled: true,
      maxConsecutiveFailures: 5,
      reconnectCooldownMs: 60_000,
      silenceTimeoutMs: 30 * 60 * 1000,
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

function getConfigPath(): string {
  return (
    process.env.LARK_BRIDGE_CONFIG ||
    resolve(homedir(), '.lark-bridge', 'config.json')
  );
}

const DEPRECATED_TOP_LEVEL = ['globalSleep', 'wrapupConsumer'] as const;
const DEPRECATED_ARIA_FIELDS = ['enabled', 'variant'] as const;

function warnDeprecatedFields(raw: any): void {
  if (!raw || typeof raw !== 'object') return;
  const found: string[] = [];
  for (const key of DEPRECATED_TOP_LEVEL) {
    if (key in raw) found.push(key);
  }
  if (raw.ariaMemory && typeof raw.ariaMemory === 'object') {
    for (const key of DEPRECATED_ARIA_FIELDS) {
      if (key in raw.ariaMemory) found.push(`ariaMemory.${key}`);
    }
  }
  if (found.length > 0) {
    console.warn(
      `⚠️  Deprecated config fields ignored: ${found.join(', ')}. ` +
        'aria-memory daemon-side schedulers are removed; primary host CLI handles drain. ' +
        'Add `{ "type": "aria-memory-wrapup" }` to hooks.session.post to opt-in.',
    );
  }
}

function parseConfig(configPath: string): BridgeConfig {
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\nRun /lark-setup to create it.`,
    );
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  warnDeprecatedFields(raw);
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

  // allowAllDirectories: inject $HOME as an additional directory
  if (config.claude.allowAllDirectories) {
    const home = homedir();
    if (!config.claude.additionalDirectories.includes(home)) {
      config.claude.additionalDirectories.push(home);
    }
  }

  // Expand ariaMemory.memoryDir
  config.ariaMemory.memoryDir = expandHome(config.ariaMemory.memoryDir);

  return config;
}

export function loadConfig(): BridgeConfig {
  return parseConfig(getConfigPath());
}

/**
 * Hot-reload config from disk. Returns the fresh config,
 * or null if parsing fails (caller should keep using old config).
 */
export function reloadConfig(): BridgeConfig | null {
  try {
    return parseConfig(getConfigPath());
  } catch (err) {
    return null;
  }
}
