/**
 * Node's timers take a signed 32-bit millisecond delay. Anything larger (about 24.8 days) is silently replaced by 1 ms,
 * which turns a "once a month" timer into a busy loop. config.ts bounds every interval well below this; schedulers clamp
 * as a second line of defence.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A delay setTimeout can honour: finite, at least 0, at most MAX_TIMER_DELAY_MS. */
export function clampDelay(ms: number): number {
  if (!Number.isFinite(ms)) return ms > 0 ? MAX_TIMER_DELAY_MS : 0;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(0, ms));
}
