/**
 * 飞书 allowlist 安全告警。
 *
 * 两个后端实际都跑在 YOLO 等价权限下（claude `canUseTool: allow` / codex
 * `sandboxMode: danger-full-access`），所以宽松的 `feishu.allowedSenders` /
 * `feishu.allowedChats` 等于把 host 当公开 shell。
 *
 * - 启动时（`emitStartupWarnings`）：对当前白名单状态全量发警告（独立 if，
 *   多个危险条件同时满足就堆叠多条 warn）。
 * - 配置热加载时（`emitReloadWarningsIfWidened`）：与上一份快照比较，仅在
 *   "更危险"时再次发警告。判定规则见 `isMoreDangerous`。
 */

import { logger } from './logger.js';

export interface FeishuAllowlist {
  allowedSenders: string[];
  allowedChats: string[];
}

/**
 * 判断 curr 是否比 prev 更危险（attack surface 扩大）。
 * - 新进入"双空 = 允许所有人"状态
 * - 任一名单长度增长（更多个体能命中放行）
 */
function isMoreDangerous(prev: FeishuAllowlist, curr: FeishuAllowlist): boolean {
  const prevDoubleEmpty =
    prev.allowedSenders.length === 0 && prev.allowedChats.length === 0;
  const currDoubleEmpty =
    curr.allowedSenders.length === 0 && curr.allowedChats.length === 0;
  if (!prevDoubleEmpty && currDoubleEmpty) return true;
  if (curr.allowedChats.length > prev.allowedChats.length) return true;
  if (curr.allowedSenders.length > prev.allowedSenders.length) return true;
  return false;
}

function emit(prefix: string, feishu: FeishuAllowlist): void {
  const senders = feishu.allowedSenders;
  const chats = feishu.allowedChats;

  if (senders.length === 0 && chats.length === 0) {
    logger.warn(
      `${prefix} allowedSenders + allowedChats both empty — anyone reaching the bot can run arbitrary host commands. Lock this down before exposing.`,
    );
  }
  if (chats.length > 0) {
    logger.warn(
      { allowedChats: chats },
      `${prefix} allowedChats is non-empty — every member of these chats can run arbitrary host commands. Prefer allowedSenders for tighter scope.`,
    );
  }
  if (senders.length > 1) {
    logger.warn(
      { senderCount: senders.length },
      `${prefix} allowedSenders has multiple entries — each one can run arbitrary host commands as this user.`,
    );
  }
}

export function emitStartupWarnings(feishu: FeishuAllowlist): void {
  emit('SECURITY:', feishu);
}

export function emitReloadWarningsIfWidened(
  prev: FeishuAllowlist,
  curr: FeishuAllowlist,
): void {
  if (!isMoreDangerous(prev, curr)) return;
  emit('SECURITY (allowlist widened on reload):', curr);
}
