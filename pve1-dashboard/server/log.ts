import type { Logger } from './context.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/** Tiny structured logger: one line per entry, journald-friendly (no timestamps; systemd adds them). */
export function createLogger(level: Level = 'info', scope = 'pve1-dash'): Logger {
  const min = LEVELS[level];
  const write = (lvl: Level, msg: string, extra?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const tail = extra && Object.keys(extra).length ? ' ' + safeJson(extra) : '';
    const line = `[${lvl}] ${scope}: ${msg}${tail}`;
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
    child: (s) => createLogger(level, `${scope}/${s}`),
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (val instanceof Error ? { message: val.message, code: (val as NodeJS.ErrnoException).code } : val));
  } catch {
    return String(v);
  }
}
