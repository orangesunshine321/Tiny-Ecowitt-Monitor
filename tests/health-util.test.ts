import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, MAX_INTERVAL_SEC } from '../server/config.js';
import { debouncedWriter, readJson, readJsonFile, writeJson } from '../server/util/jsonstore.js';
import { clampDelay, MAX_TIMER_DELAY_MS } from '../server/util/timers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pve1-dash-util-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('jsonstore', () => {
  it('readJsonFile tells missing, ok, corrupt and unreadable apart', () => {
    expect(readJsonFile(join(dir, 'nope.json'))).toEqual({ status: 'missing' });
    writeFileSync(join(dir, 'ok.json'), '{"a":1}');
    expect(readJsonFile(join(dir, 'ok.json'))).toEqual({ status: 'ok', value: { a: 1 } });
    writeFileSync(join(dir, 'bad.json'), '{"a":');
    expect(readJsonFile(join(dir, 'bad.json')).status).toBe('corrupt');
    mkdirSync(join(dir, 'dir.json'));
    expect(readJsonFile(join(dir, 'dir.json')).status).toBe('unreadable');
  });

  it('readJson falls back and reports damage (but not a missing file)', () => {
    const errors: Error[] = [];
    writeFileSync(join(dir, 'bad.json'), '{');
    expect(readJson(join(dir, 'bad.json'), 'fallback', (e) => errors.push(e))).toBe('fallback');
    expect(readJson(join(dir, 'missing.json'), 'fallback', (e) => errors.push(e))).toBe('fallback');
    expect(errors).toHaveLength(1);
  });

  it('writeJson writes atomically with mode 0600 and leaves no temp file behind on failure', () => {
    const file = join(dir, 'state.json');
    writeJson(file, { a: 1 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['state.json']);

    // the target is a non-empty directory: the rename fails, the old content stays, the temp file is removed
    const blocked = join(dir, 'blocked.json');
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'keep'), 'x');
    expect(() => writeJson(blocked, { b: 2 })).toThrow();
    expect(readdirSync(dir).sort()).toEqual(['blocked.json', 'state.json']);
  });

  it('a failing debounced write is reported and retried instead of throwing from the timer', async () => {
    vi.useFakeTimers();
    const notADir = join(dir, 'file');
    writeFileSync(notADir, 'x');
    const errors: unknown[] = [];
    let value = { n: 1 };
    const target = join(notADir, 'sub', 'state.json'); // mkdir fails: ENOTDIR
    const w = debouncedWriter(target, () => value, 1000, (e) => errors.push(e));
    w.save();
    w.save(); // coalesced
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toHaveLength(1);
    expect((errors[0] as NodeJS.ErrnoException).code).toBe('ENOTDIR');
    await vi.advanceTimersByTimeAsync(1000); // retried
    expect(errors).toHaveLength(2);
    expect(() => w.flush()).toThrow(); // explicit flush still throws (callers at shutdown catch it)

    // once the path works again the retry succeeds and stops
    const ok = debouncedWriter(join(dir, 'ok.json'), () => value, 1000, (e) => errors.push(e));
    value = { n: 2 };
    ok.save();
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(readFileSync(join(dir, 'ok.json'), 'utf8'))).toEqual({ n: 2 });
  });

  it('a throwing onError does not escape the timer either', async () => {
    vi.useFakeTimers();
    writeFileSync(join(dir, 'file'), 'x');
    const w = debouncedWriter(join(dir, 'file', 'x.json'), () => ({}), 10, () => {
      throw new Error('logger broke');
    });
    w.save();
    await expect(vi.advanceTimersByTimeAsync(10)).resolves.not.toThrow();
  });
});

describe('timer bounds', () => {
  const base = { proxmox: { url: 'https://10.10.20.10:8006', tokenId: 'dash@pve!ro', tokenSecret: 'x' } };

  it('config intervals and timeouts are bounded below the setTimeout overflow', () => {
    // a "monthly" update check used to overflow setTimeout and run every ~1 ms
    const monthly = ConfigSchema.safeParse({ ...base, polling: { updates: 2_678_400 } });
    expect(monthly.success).toBe(false);
    expect(JSON.stringify(monthly.error?.issues)).toContain('7 days');
    expect(ConfigSchema.parse({ ...base, polling: { updates: MAX_INTERVAL_SEC } }).polling.updates).toBe(MAX_INTERVAL_SEC);
    for (const over of [
      { inventory: { interval: 30 * 86_400 } },
      { services: { checkInterval: 30 * 86_400 } },
      { alerts: { rules: { nodeUnreachable: { afterSeconds: 30 * 86_400 } } } },
      { proxmox: { ...base.proxmox, timeoutMs: 3_000_000_000 } },
      { services: { timeoutMs: 3_000_000_000 } },
      { inventory: { timeoutMs: 3_000_000_000 } },
    ]) {
      expect(ConfigSchema.safeParse({ ...base, ...over }).success, JSON.stringify(over)).toBe(false);
    }
    expect(MAX_INTERVAL_SEC * 1000).toBeLessThan(MAX_TIMER_DELAY_MS);
  });

  it('clampDelay keeps delays within what setTimeout honours', () => {
    expect(clampDelay(5000)).toBe(5000);
    expect(clampDelay(-5)).toBe(0);
    expect(clampDelay(2_678_400_000)).toBe(MAX_TIMER_DELAY_MS);
    expect(clampDelay(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_DELAY_MS);
    expect(clampDelay(Number.NaN)).toBe(0);
  });
});
