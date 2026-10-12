/**
 * Typed wrapper around the root forced-command helper on the Proxmox host (/usr/local/sbin/pve1-dash-helper,
 * docs/HELPER_PROTOCOL.md). Every method resolves to null when the helper is not configured or the call failed;
 * failures are logged once at warn and then at debug while they persist (rate limited per command).
 */
import type { GuestInventory, HostInventory } from '../../shared/types.js';
import type { AppContext, CommandResult, CommandRunner, HostHelper, Logger } from '../context.js';
import { extractJson, lastLine, parseHostInventory, parseJsonArray, parseSensors } from './parse.js';

/** Same rule as the helper: ^[A-Za-z][A-Za-z0-9._-]{0,63}$ */
export const STORAGE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const isVmid = (v: number) => Number.isInteger(v) && v > 0 && v <= 999_999_999;

/**
 * Rate-limited failure logging: the first failure for a key is a warning, repeats within `windowMs` are debug, and the
 * first success after a failure is logged at info.
 */
export function createFailureLog(log: Logger, windowMs = 10 * 60_000) {
  const state = new Map<string, { lastWarn: number; suppressed: number; message: string }>();
  return {
    fail(key: string, msg: string, extra: Record<string, unknown> = {}): void {
      const now = Date.now();
      const s = state.get(key);
      const detail = typeof extra.error === 'string' ? `${msg}: ${extra.error}` : msg;
      if (!s || now - s.lastWarn >= windowMs) {
        log.warn(msg, s?.suppressed ? { ...extra, repeatedSinceLastWarning: s.suppressed } : extra);
        state.set(key, { lastWarn: now, suppressed: 0, message: detail });
      } else {
        s.suppressed++;
        s.message = detail;
        log.debug(msg, extra);
      }
    },
    ok(key: string, recoveredMsg?: string): void {
      if (state.delete(key) && recoveredMsg) log.info(recoveredMsg);
    },
    /** the latest failure message for a key, while it is failing */
    lastError(key: string): string | undefined {
      return state.get(key)?.message;
    },
  };
}

/** HostHelper plus a way to learn why the last call of a command failed (for collector status). */
export interface HostHelperWithDiagnostics extends HostHelper {
  /** e.g. lastError('inventory') / lastError('sensors'); undefined when the last call succeeded */
  lastError(command: string): string | undefined;
}

export function createHostHelper(ctx: AppContext, runner: CommandRunner): HostHelperWithDiagnostics {
  const log = ctx.log.child('host-helper');
  const inv = ctx.config.inventory;
  // inventory.enabled: false means no SSH at all, including the host helper.
  const target = inv.enabled ? inv.host : undefined;
  const failures = createFailureLog(log);
  const capped = (ms: number) => Math.min(inv.timeoutMs, ms);

  async function call(key: string, command: string, timeoutMs: number): Promise<CommandResult | null> {
    if (!target) return null;
    let r: CommandResult;
    try {
      r = await runner.run(target, command, timeoutMs);
    } catch (e) {
      failures.fail(key, `host helper "${command}" failed`, { error: (e as Error).message });
      return null;
    }
    if (r.code === 1 && /^denied$/m.test(r.stderr)) {
      failures.fail(key, `host helper denied "${command}"`, {
        error: 'denied by /usr/local/sbin/pve1-dash-helper (outdated helper? re-run the installer)',
      });
      return null;
    }
    return r;
  }

  async function guests(vmid?: number): Promise<GuestInventory[] | null> {
    if (vmid !== undefined && !isVmid(vmid)) {
      log.warn('refusing inventory for an invalid vmid', { vmid });
      return null;
    }
    const command = vmid === undefined ? 'inventory' : `inventory ${vmid}`;
    // A full sweep visits every guest (25 s each, 4 at a time); a single guest needs listing + one exec.
    const r = await call('inventory', command, vmid === undefined ? inv.timeoutMs : capped(90_000));
    if (!r) return null;
    const parsed = parseHostInventory(r.stdout, Date.now());
    if (!parsed) {
      failures.fail('inventory', 'host helper returned no inventory', {
        error: lastLine(r.stderr) || `exit code ${r.code ?? 'none (timeout)'}`,
      });
      return null;
    }
    if (!parsed.complete && r.code !== null && r.code !== 0) {
      // The helper gave up by itself (e.g. it could not list the guests): nothing in this run is trustworthy.
      failures.fail('inventory', 'host helper inventory failed', {
        error: lastLine(r.stderr) || `exit code ${r.code}`,
      });
      return null;
    }
    if (!parsed.complete) {
      // Partial output (our own timeout hit): finished guests are still usable, cut-off ones carry an error.
      failures.fail('inventory-incomplete', 'host helper inventory was cut off', {
        error: lastLine(r.stderr) || `exit code ${r.code ?? 'none (timeout)'}`,
        guests: parsed.inventories.length,
      });
    } else failures.ok('inventory-incomplete');
    failures.ok('inventory', 'host helper inventory is working again');
    for (const g of parsed.inventories) {
      if (!g.ok) log.debug('guest could not be inspected', { vmid: g.vmid, source: g.source, error: g.error });
    }
    return vmid === undefined ? parsed.inventories : parsed.inventories.filter((g) => g.vmid === vmid);
  }

  async function host(): Promise<HostInventory | null> {
    const r = await call('sensors', 'sensors', capped(30_000));
    if (!r) return null;
    const collectedAt = Date.now();
    if (r.code === 3) {
      failures.ok('sensors');
      return { collectedAt, ok: true, temps: [], sensorsAvailable: false };
    }
    // sensors may exit non-zero after a chip read error yet still print valid JSON
    const json = extractJson(r.stdout);
    if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
      failures.ok('sensors', 'host sensors are readable again');
      return { collectedAt, ok: true, temps: parseSensors(json), sensorsAvailable: true };
    }
    if (/No sensors found/i.test(r.stderr)) {
      failures.ok('sensors');
      return { collectedAt, ok: true, temps: [], sensorsAvailable: true };
    }
    failures.fail('sensors', 'host sensors output could not be read', {
      error: lastLine(r.stderr) || `exit code ${r.code ?? 'none (timeout)'}`,
    });
    return null;
  }

  async function jsonArray(key: string, command: string, timeoutMs: number): Promise<unknown[] | null> {
    const r = await call(key, command, timeoutMs);
    if (!r) return null;
    const arr = r.code === 0 ? parseJsonArray(r.stdout) : null;
    if (!arr) {
      failures.fail(key, `host helper "${command}" returned no JSON array`, {
        error: lastLine(r.stderr) || `exit code ${r.code ?? 'none (timeout)'}`,
      });
      return null;
    }
    failures.ok(key, `host helper "${command}" is working again`);
    return arr;
  }

  return {
    available: () => target !== undefined,
    guests,
    host,
    pkgUpdates: () => jsonArray('pkgupdates', 'pkgupdates', capped(30_000)),
    async backups(storage: string) {
      if (typeof storage !== 'string' || !STORAGE_ID_RE.test(storage)) {
        log.warn('refusing backups for an invalid storage id', { storage });
        return null;
      }
      // The helper allows pvesh 90 s (a PBS storage can be slow); the default inventory.timeoutMs (120 s) covers that.
      return jsonArray(`backups:${storage}`, `backups ${storage}`, inv.timeoutMs);
    },
    lastError: (command: string) => failures.lastError(command),
  };
}
