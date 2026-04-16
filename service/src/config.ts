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
   * aria-memory integration toggle. When enabled, lark-bridge will:
   *   - Export session transcripts to memoryDir/transcripts/
   *   - Register pending wrapups in memoryDir/meta.json
   *   - Run GlobalSleepScheduler and PendingWrapupConsumer
   *   - Auto-inject aria-memory-wrapup hook into session.post (if hooks not explicitly set)
   *
   * When disabled (default), none of the above runs — lark-bridge operates as
   * a pure Feishu↔Claude bridge with no memory persistence.
   */
  ariaMemory: z
    .object({
      enabled: z.boolean().default(false),
      /**
       * Integration variant:
       *   - "vanilla": Export transcripts only. No meta.json, no daemon schedulers.
       *     Relies on aria-memory plugin's own hooks for processing.
       *   - "custom": Full integration — transcript export + meta.json pendingWrapups
       *     registration + GlobalSleepScheduler + PendingWrapupConsumer.
       *     Requires the custom aria-memory vault with meta.json support.
       */
      variant: z.enum(['vanilla', 'custom']).default('vanilla'),
      /** Path to the aria-memory vault directory. Default: ~/.aria-memory */
      memoryDir: z.string().default('~/.aria-memory'),
    })
    .default({ enabled: false, variant: 'vanilla', memoryDir: '~/.aria-memory' }),
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
  session: z
    .object({
      idleTimeoutMs: z.number().default(30 * 60 * 1000),
      maxDurationMs: z.number().default(4 * 60 * 60 * 1000),
    })
    .default({
      idleTimeoutMs: 30 * 60 * 1000,
      maxDurationMs: 4 * 60 * 60 * 1000,
    }),
  globalSleep: z
    .object({
      /** Whether to enable the global_sleep scheduler. Default: false (auto-enabled when ariaMemory.enabled=true). */
      enabled: z.boolean().optional(),
      /** How often to check conditions, in ms. Default: 30 minutes. Min: 1 minute. */
      checkIntervalMs: z.number().min(60_000).default(30 * 60 * 1000),
      /**
       * Minimum time between global_sleep runs, in ms. Default: 6 hours.
       * Min: 1 hour. This is the floor — sleep never fires more often than
       * this regardless of new work.
       */
      cooldownMs: z.number().min(3_600_000).default(6 * 60 * 60 * 1000),
      /**
       * Strong-trigger heuristic: fire when at least this many new impression
       * files exist in ~/.aria-memory/impressions/ since the last successful
       * sleep (mtime > lastGlobalSleepAt). Default 2, mirrors aria-memory's
       * own SessionStart hook recommendation.
       */
      minNewImpressions: z.number().min(1).default(2),
      /**
       * Strong-trigger heuristic: fire when this much wall-clock time has
       * passed since the last successful sleep, regardless of new work
       * count. Default 12 hours, mirrors aria-memory's SessionStart hook.
       * Min: 1 hour (must be >= cooldownMs to be meaningful).
       */
      staleAfterMs: z.number().min(3_600_000).default(12 * 60 * 60 * 1000),
    })
    .default({
      checkIntervalMs: 30 * 60 * 1000,
      cooldownMs: 6 * 60 * 60 * 1000,
      minNewImpressions: 2,
      staleAfterMs: 12 * 60 * 60 * 1000,
    }),
  wrapupConsumer: z
    .object({
      /** Whether to enable the pending wrapup consumer scheduler. Default: false (auto-enabled when ariaMemory.enabled=true). */
      enabled: z.boolean().optional(),
      /** How often to check conditions, in ms. Default: 30 minutes. Min: 1 minute. */
      checkIntervalMs: z.number().min(60_000).default(30 * 60 * 1000),
      /** Minimum time between successful wrapup runs, in ms. Default: 1 hour. Min: 5 minutes. */
      cooldownMs: z.number().min(300_000).default(60 * 60 * 1000),
      /**
       * Primary trigger: fire when pendingWrapups.length >= this. Also
       * doubles as the threshold at which global_sleep defers to wrapup
       * (so the queue drains before the heavier sleep pass runs). Default 5
       * — high enough to amortize per-invocation claude startup cost.
       */
      pendingThreshold: z.number().min(1).default(5),
      /**
       * Age-based fallback: even if pending is below pendingThreshold,
       * fire when the oldest pending entry has been waiting longer than
       * this. Without this, a steady-state of 1-4 pending would never get
       * drained until the queue piled up. Default 6h, mirrors the
       * global_sleep cooldown. Min 1h.
       */
      pendingMaxAgeMs: z.number().min(3_600_000).default(6 * 60 * 60 * 1000),
    })
    .default({
      checkIntervalMs: 30 * 60 * 1000,
      cooldownMs: 60 * 60 * 1000,
      pendingThreshold: 5,
      pendingMaxAgeMs: 6 * 60 * 60 * 1000,
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

function parseConfig(configPath: string): BridgeConfig {
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\nRun /lark-setup to create it.`,
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

  // allowAllDirectories: inject $HOME as an additional directory
  if (config.claude.allowAllDirectories) {
    const home = homedir();
    if (!config.claude.additionalDirectories.includes(home)) {
      config.claude.additionalDirectories.push(home);
    }
  }

  // Expand ariaMemory.memoryDir
  config.ariaMemory.memoryDir = expandHome(config.ariaMemory.memoryDir);

  // ── aria-memory auto-wiring ──
  //
  // Three modes:
  //   1. disabled (enabled=false): no memory, no hooks, no schedulers
  //   2. vanilla  (enabled=true, variant="vanilla"): transcript export only,
  //      no meta.json manipulation, no daemon schedulers
  //   3. custom   (enabled=true, variant="custom"): full integration with
  //      meta.json pendingWrapups + GlobalSleepScheduler + PendingWrapupConsumer
  //
  if (config.ariaMemory.enabled) {
    // Auto-inject aria-memory-wrapup hook into session.post if not
    // explicitly configured by the user.
    const hasWrapupHook = config.hooks.session.post.some(
      (h) => h.type === 'aria-memory-wrapup',
    );
    if (!hasWrapupHook && !raw.hooks?.session?.post) {
      config.hooks.session.post.push({ type: 'aria-memory-wrapup' });
    }

    if (config.ariaMemory.variant === 'custom') {
      // Custom mode: auto-enable schedulers unless explicitly disabled
      if (config.globalSleep.enabled === undefined) {
        (config.globalSleep as any).enabled = true;
      }
      if (config.wrapupConsumer.enabled === undefined) {
        (config.wrapupConsumer as any).enabled = true;
      }
    } else {
      // Vanilla mode: schedulers off (they need meta.json infrastructure)
      if (config.globalSleep.enabled === undefined) {
        (config.globalSleep as any).enabled = false;
      }
      if (config.wrapupConsumer.enabled === undefined) {
        (config.wrapupConsumer as any).enabled = false;
      }
    }
  } else {
    // Disabled: force everything off
    if (config.globalSleep.enabled === undefined) {
      (config.globalSleep as any).enabled = false;
    }
    if (config.wrapupConsumer.enabled === undefined) {
      (config.wrapupConsumer as any).enabled = false;
    }
  }

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
