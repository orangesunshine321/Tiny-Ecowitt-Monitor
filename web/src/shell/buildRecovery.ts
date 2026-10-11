/**
 * Recovery from a replaced build (see ErrorBoundary.tsx): recognise a failed chunk load and reload once, with a guard
 * against reload loops. Pure helpers, unit-tested in tests/web-shell-recovery.test.ts.
 */

const RELOAD_KEY = 'pve1-dash.build-reload-at';
/** no second automatic reload within this window: the chunk is really missing, or the device is offline */
export const RELOAD_GUARD_MS = 60_000;

/** A failed dynamic import or CSS/JS preload (wording differs per engine). */
export function isChunkLoadError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script|ChunkLoadError|Loading (CSS )?chunk [\w-]+ failed/i.test(
    text,
  );
}

type SessionLike = Pick<Storage, 'getItem' | 'setItem'>;

function session(): SessionLike | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Reload once to load the current build. Returns false (and does nothing) when a reload already happened within
 * RELOAD_GUARD_MS, or when there is no sessionStorage to guard against a reload loop.
 */
export function reloadForNewBuild(now = Date.now(), storage: SessionLike | undefined = session(), reload: () => void = () => location.reload()): boolean {
  if (!storage) return false;
  let last = 0;
  try {
    last = Number(storage.getItem(RELOAD_KEY) ?? 0);
  } catch {
    return false;
  }
  if (Number.isFinite(last) && now - last >= 0 && now - last < RELOAD_GUARD_MS) return false;
  try {
    storage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}
