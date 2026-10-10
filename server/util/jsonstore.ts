import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** Read a JSON file, returning `fallback` if missing or corrupt. */
export function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomically write JSON (write temp + rename). `mode` defaults to 0600 since files may hold secrets. */
export function writeJson(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  renameSync(tmp, path);
}

/** Debounced writer so hot paths can call save() freely; call flush() on shutdown. */
export function debouncedWriter(path: string, getValue: () => unknown, delayMs = 2000): { save(): void; flush(): void } {
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    writeJson(path, getValue());
  };
  return {
    save() {
      if (timer) return;
      timer = setTimeout(flush, delayMs);
      timer.unref?.();
    },
    flush,
  };
}
