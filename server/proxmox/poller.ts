import type { Logger } from '../context.js';
import type { Store } from '../state.js';

/** A collector may report a partial failure (data was published, but something was missing). */
export interface PollOutcome {
  warning?: string;
}

export interface PollerOptions {
  /** collector name as shown in meta.collectors (matches the config.polling key) */
  name: string;
  intervalSec: number;
  store: Store;
  log: Logger;
  run(signal: AbortSignal): Promise<PollOutcome | void>;
}

/** Cap for the error backoff: never longer than this, unless the normal interval is longer. */
const MAX_BACKOFF_MS = 60_000;

/**
 * Delay before the next run after `failures` consecutive errors (0 = healthy → the normal interval).
 * Retries start at min(interval, 30 s) and double each time, capped at max(interval, 60 s): a 5 s poller backs off
 * 5→10→20→40→60 s; an hourly poller retries after 30 s, 60 s, … up to its hour instead of waiting a full interval.
 */
export function backoffDelayMs(intervalSec: number, failures: number): number {
  const interval = intervalSec * 1000;
  if (failures <= 0) return interval;
  const base = Math.min(interval, 30_000);
  const cap = Math.max(interval, MAX_BACKOFF_MS);
  return Math.min(cap, base * 2 ** Math.min(failures - 1, 20));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs one collector forever: first run immediately, never overlapping (the next run is scheduled only after the
 * current one settles), exponential backoff on errors, freshness reported to the Store.
 */
export class Poller {
  readonly name: string;
  private timer: NodeJS.Timeout | undefined;
  private abort: AbortController | undefined;
  private inflight: Promise<void> | undefined;
  private failures = 0;
  private lastLoggedError = '';
  private active = false;

  constructor(private readonly opts: PollerOptions) {
    this.name = opts.name;
  }

  get running(): boolean {
    return this.active;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.abort = new AbortController();
    this.schedule(0);
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
  }

  /** Run now unless a run is already in flight (then wait for that one). Resolves when the run settled. */
  async runNow(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.tick();
  }

  private schedule(delayMs: number): void {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private tick(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.timer = undefined;
    const signal = this.abort?.signal ?? new AbortController().signal;
    this.inflight = this.execute(signal).finally(() => {
      this.inflight = undefined;
      this.schedule(backoffDelayMs(this.opts.intervalSec, this.failures));
    });
    return this.inflight;
  }

  private async execute(signal: AbortSignal): Promise<void> {
    const { name, intervalSec, store, log } = this.opts;
    try {
      const outcome = await this.opts.run(signal);
      if (signal.aborted) return;
      if (this.failures > 0) log.info(`${name}: recovered after ${this.failures} failed attempt(s)`);
      this.failures = 0;
      this.lastLoggedError = '';
      store.collectorOk(name, intervalSec);
      if (outcome?.warning) {
        // Partial success: data was published, but report what is missing (lastErrorAt >= lastSuccess).
        store.collectorError(name, intervalSec, outcome.warning);
        log.debug(`${name}: partial result`, { warning: outcome.warning });
      }
    } catch (err) {
      if (signal.aborted) return;
      this.failures++;
      store.collectorError(name, intervalSec, err);
      const msg = errMessage(err);
      // Log the first failure and every change of message at warn; repeats at debug to keep the journal readable.
      if (msg !== this.lastLoggedError) {
        log.warn(`${name}: ${msg}`, { failures: this.failures, retryInMs: backoffDelayMs(intervalSec, this.failures) });
        this.lastLoggedError = msg;
      } else {
        log.debug(`${name}: still failing`, { failures: this.failures });
      }
    }
  }
}
