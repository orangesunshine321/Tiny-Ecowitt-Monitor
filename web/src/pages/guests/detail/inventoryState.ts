/**
 * What the Apps segment can show for a guest, and why not when it can't (pure; tested in tests/web-guests-util.test.ts).
 *
 * Inventory is collected over SSH (docs/HELPER_PROTOCOL.md): `pct exec` for containers, `qm guest exec` for VMs with an
 * enabled guest agent, direct SSH for VMs listed under `inventory.guests`. Stopped guests and templates are skipped.
 */
import type { CollectorStatus, Guest, GuestInventory } from '../../../../../shared/types';
import { isWindows } from '../guestUtil';

export type InventoryView =
  /** inventory.enabled is false in config.yaml */
  | { kind: 'disabled' }
  | { kind: 'template' }
  /** not running; `stale` is what was seen while it last ran (if anything) */
  | { kind: 'stopped'; stale?: GuestInventory }
  | { kind: 'windows'; error?: string }
  /**
   * can't be inspected by design (the server says `inspectable: 'unsupported'`): HAOS with guest-exec disabled, a VM with
   * no agent and no SSH target. Informational, never a failure.
   */
  | { kind: 'unsupported'; reason: InventoryReason }
  /** a VM without an enabled guest agent and not configured for direct SSH */
  | { kind: 'no-agent' }
  /** nothing collected yet; `sweepError` is the last failure of the inventory collector, if any */
  | { kind: 'pending'; sweepError?: string }
  /** the last attempt failed and there is no earlier data */
  | { kind: 'error'; inv: GuestInventory; reason: InventoryReason }
  /** data to show; `failed` is set when the latest refresh failed and the data is from an earlier run */
  | { kind: 'ok'; inv: GuestInventory; failed?: InventoryReason };

export interface InventoryReason {
  title: string;
  message: string;
  /** the raw error from the collector (shown in monospace) */
  raw?: string;
}

/** Same notion as the server: does this entry hold anything worth showing? */
export function hasInventoryData(inv: GuestInventory): boolean {
  return Boolean(
    inv.os || inv.kernel || inv.uptime !== undefined || inv.services?.length || inv.containers?.length || inv.ips?.length || inv.ports?.length,
  );
}

/** Turn a collector error into a sentence a person can act on. */
export function explainInventoryError(error: string | undefined, guest: Pick<Guest, 'osName' | 'config' | 'type'>): InventoryReason {
  const raw = (error ?? '').trim();
  const e = raw.toLowerCase();
  const haos = /home assistant/i.test(guest.osName ?? '');
  if (/guest-exec/.test(e) && /disabl/.test(e)) {
    return {
      title: 'Commands are disabled in this VM’s guest agent',
      message: haos
        ? 'Home Assistant OS ships its QEMU guest agent with guest-exec turned off, so pve1-dash can’t look inside. Resources, IPs and backups still work.'
        : 'The QEMU guest agent here refuses guest-exec, so pve1-dash can’t look inside. Allow it in the agent’s configuration, or set the VM up for direct SSH.',
      raw: raw || undefined,
    };
  }
  if (/windows|unsupported os/.test(e) || isWindows(guest)) {
    return {
      title: 'Windows isn’t supported',
      message: 'The inventory helper is a POSIX shell script, so it can only look inside Linux and BSD guests.',
      raw: raw || undefined,
    };
  }
  if (/agent/.test(e) && /(not running|not available|no qemu guest agent|isn.t running|timeout|not responding)/.test(e)) {
    return {
      title: 'The QEMU guest agent isn’t responding',
      message: 'Install and start qemu-guest-agent inside the VM (and keep the agent option enabled in Proxmox), then refresh.',
      raw: raw || undefined,
    };
  }
  if (/timed? ?out|exit code 124|etimedout/.test(e)) {
    return {
      title: 'The guest took too long to answer',
      message: 'It may be busy or hung. pve1-dash will try again on the next sweep.',
      raw: raw || undefined,
    };
  }
  if (/permission denied|publickey|not allowed|denied/.test(e)) {
    return {
      title: 'Access was refused',
      message: 'The forced-command SSH key was rejected. Re-run the guest setup command (Settings → Data sources) to reinstall it.',
      raw: raw || undefined,
    };
  }
  if (/econnrefused|ehostunreach|enetunreach|enotfound|connect|unreachable|no route/.test(e)) {
    return {
      title: 'Couldn’t reach the guest over SSH',
      message: 'Check that sshd is running in the guest and that its address in config.yaml is right.',
      raw: raw || undefined,
    };
  }
  return {
    title: 'Inventory collection failed',
    message:
      guest.type === 'lxc'
        ? 'pve1-dash ran `pct exec` on pve1 but got no usable answer.'
        : 'pve1-dash asked the guest for its inventory but got no usable answer.',
    raw: raw || undefined,
  };
}

/** Why a guest the server marked `inspectable: 'unsupported'` can't be looked into (worded as a fact, not an error). */
export function explainUnsupported(error: string | undefined, guest: Pick<Guest, 'osName' | 'config' | 'type'>): InventoryReason {
  const known = explainInventoryError(error, guest);
  if (known.title !== 'Inventory collection failed') return known;
  const raw = (error ?? '').trim() || undefined;
  if (guest.type === 'qemu' && !guest.config?.agentEnabled) {
    return {
      title: 'This VM can’t be looked into',
      message: 'It has no QEMU guest agent and no direct SSH target, so pve1-dash can’t list its apps. Resources, IPs and backups still work.',
      raw,
    };
  }
  return {
    title: 'This guest can’t be looked into',
    message: 'pve1-dash has no way to run its read-only inventory here. Resources, IPs and backups still work.',
    raw,
  };
}

/** Decide what the Apps segment shows for this guest. */
export function inventoryView(
  guest: Pick<Guest, 'type' | 'status' | 'template' | 'osName' | 'config'>,
  inv: GuestInventory | undefined,
  opts: { enabled: boolean; collectors?: readonly CollectorStatus[] },
): InventoryView {
  if (!opts.enabled && !inv) return { kind: 'disabled' };
  if (guest.template) return { kind: 'template' };
  if (inv?.inspectable === 'unsupported' && !(inv.ok && hasInventoryData(inv))) {
    if (isWindows(guest) || /windows/i.test(inv.error ?? '')) return { kind: 'windows', error: inv.error };
    return { kind: 'unsupported', reason: explainUnsupported(inv.error, guest) };
  }
  // Windows can never be inspected, running or not (unless an earlier collection somehow has data)
  if (isWindows(guest) && !(inv && hasInventoryData(inv))) return { kind: 'windows', error: inv?.error };
  if (guest.status !== 'running') return { kind: 'stopped', stale: inv && hasInventoryData(inv) ? inv : undefined };
  if (inv) {
    if (inv.ok) return { kind: 'ok', inv };
    const reason = explainInventoryError(inv.error, guest);
    if (hasInventoryData(inv)) return { kind: 'ok', inv, failed: reason };
    if (isWindows(guest) || /windows|unsupported os/i.test(inv.error ?? '')) return { kind: 'windows', error: inv.error };
    return { kind: 'error', inv, reason };
  }
  if (isWindows(guest)) return { kind: 'windows' };
  if (guest.type === 'qemu' && guest.config && !guest.config.agentEnabled) return { kind: 'no-agent' };
  const sweep = opts.collectors?.find((c) => c.name === 'inventory');
  const sweepError = sweep?.lastError && (!sweep.lastSuccess || (sweep.lastErrorAt ?? 0) >= sweep.lastSuccess) ? sweep.lastError : undefined;
  return { kind: 'pending', sweepError };
}

/** "pct exec" / "guest agent" / "SSH" — how an inventory was collected, for the freshness note. */
export function sourceLabel(source: GuestInventory['source']): string {
  switch (source) {
    case 'pct-exec':
      return 'pct exec';
    case 'qm-guest-exec':
      return 'the guest agent';
    case 'ssh':
      return 'SSH';
    default:
      return String(source);
  }
}

/** The YAML to add under config.yaml for a VM reached directly over SSH. */
export function directSshSnippet(vmid: number, address: string | undefined): string {
  return ['inventory:', '  guests:', `    - vmid: ${vmid}`, `      address: ${address ?? '<guest-ip>'}`].join('\n');
}
