import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Result of reading a JSON state file: missing is normal (first start); unreadable and corrupt are not. */
export type JsonFileRead<T> =
  | { status: 'missing' }
  | { status: 'ok'; value: T }
  /** the file exists but could not be read (EACCES, EIO, EISDIR, ...): leave it alone */
  | { status: 'unreadable'; error: Error }
  /** the file was read but is not valid JSON (e.g. truncated by a crash) */
  | { status: 'corrupt'; error: Error };

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/** Read a JSON file and say exactly what happened, so callers can tell "first start" from "damaged file". */
export function readJsonFile<T>(path: string): JsonFileRead<T> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', error: asError(err) };
  }
  try {
    return { status: 'ok', value: JSON.parse(text) as T };
  } catch (err) {
    return { status: 'corrupt', error: asError(err) };
  }
}

/**
 * Read a JSON file, returning `fallback` if it is missing, unreadable or corrupt. `onError` is told about the last two
 * (a missing file is not an error). Use readJsonFile() when a damaged file must not be treated like a missing one.
 */
export function readJson<T>(path: string, fallback: T, onError?: (err: Error) => void): T {
  const r = readJsonFile<T>(path);
  if (r.status === 'ok') return r.value;
  if (r.status !== 'missing') onError?.(r.error);
  return fallback;
}

/**
 * Atomically and durably write JSON: write a temp file, fsync it, rename it over `path`, fsync the directory. A crash or
 * power loss leaves either the old or the new file, never an empty one. `mode` defaults to 0600 since files may hold
 * secrets. On failure the temp file is removed and the error is thrown (the old file stays as it was).
 */
export function writeJson(path: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2), mode);
}

/** Atomically and durably write text (see writeJson). */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w', mode);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
  // Persist the rename itself. Some filesystems refuse fsync on a directory; the data is already safe then.
  try {
    const dfd = openSync(dir, 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* not supported here */
  }
}

export interface DebouncedWriter {
  /** schedule a write in `delayMs` (no-op while one is pending) */
  save(): void;
  /** write now and cancel the pending write; throws on I/O errors (callers at shutdown catch it) */
  flush(): void;
}

/**
 * Debounced writer so hot paths can call save() freely; call flush() on shutdown.
 *
 * A write that fails inside the timer (disk full, read-only filesystem, permissions) must not become an uncaught
 * exception, which would kill the process: it is reported to `onError` and retried after another `delayMs`.
 */
export function debouncedWriter(path: string, getValue: () => unknown, delayMs = 2000, onError?: (err: unknown) => void): DebouncedWriter {
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    writeJson(path, getValue());
  };
  const arm = () => {
    timer = setTimeout(() => {
      timer = undefined;
      try {
        writeJson(path, getValue());
      } catch (err) {
        try {
          onError?.(err);
        } catch {
          /* a failing logger must not crash the process either */
        }
        if (!timer) arm(); // retry later; the data is still in memory
      }
    }, delayMs);
    timer.unref?.();
  };
  return {
    save() {
      if (timer) return;
      arm();
    },
    flush,
  };
}
