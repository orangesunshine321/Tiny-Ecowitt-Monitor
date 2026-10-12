/**
 * Guest detail → Apps: Docker containers grouped by compose project, services, listening ports — or a clear
 * explanation of why the inventory isn't available (inventory off, template, stopped, Windows, no guest agent, HAOS
 * with guest-exec disabled, not collected yet, collection errors).
 */
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  CirclePause,
  Copy,
  EyeOff,
  Layers,
  MonitorOff,
  PackageX,
  Plug,
  RefreshCw,
  ScrollText,
  ShieldOff,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { DockerContainer, Guest, GuestInventory, ListeningPort, ServiceEntry, Snapshot, SnapshotMeta } from '../../../../../shared/types';
import { guestSetupCommand } from '../../../api';
import {
  AppIcon,
  Button,
  Card,
  EmptyState,
  ListGroup,
  RelativeTime,
  StatusBadge,
  Table,
  Toggle,
  toneOf,
  type TableColumn,
} from '../../../components';
import { plural } from '../../../format';
import { pushToast, useSnapshot } from '../../../store';
import {
  containerIconSlug,
  containerService,
  containerStatusText,
  groupContainers,
  guestAddresses,
  portLink,
  primaryIp,
  proxiedAppUrl,
  publishedPorts,
  type ContainerGroup,
} from '../guestUtil';
import { directSshSnippet, inventoryView, sourceLabel, type InventoryReason } from './inventoryState';

export interface AppsTabProps {
  guest: Guest;
  inv?: GuestInventory;
  meta: SnapshotMeta;
  onRefresh: () => void;
  refreshing: boolean;
}

// ───────────────────────────────────────────────────────────── copyable code

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // insecure context / denied permission: select-and-copy fallback
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function CodeBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="gd-code">
      <pre aria-label={label}>
        <code>{text}</code>
      </pre>
      <Button
        variant="gray"
        size="small"
        icon={copied ? <Check size={14} strokeWidth={2.6} /> : <Copy size={14} strokeWidth={2.2} />}
        onClick={async () => {
          const ok = await copyText(text);
          if (ok) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } else pushToast({ tone: 'warn', title: 'Couldn’t copy', body: 'Select the text and copy it manually.' });
        }}
        aria-label={`Copy ${label}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── unavailable states

function Unavailable({
  icon: Icon,
  title,
  children,
  action,
  tone,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  tone?: 'warn' | 'off';
}) {
  return (
    <Card className="gd-unavailable">
      <EmptyState icon={<Icon size={26} strokeWidth={1.9} />} title={title} message={children} action={action} tone={tone} />
    </Card>
  );
}

function RawError({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <details className="gd-raw">
      <summary>Details</summary>
      <code>{text}</code>
    </details>
  );
}

function ReasonView({ reason, action }: { reason: InventoryReason; action?: ReactNode }) {
  return (
    <Unavailable icon={ShieldOff} title={reason.title} tone="warn" action={action}>
      <span className="gd-msg">{reason.message}</span>
      <RawError text={reason.raw} />
    </Unavailable>
  );
}

// ───────────────────────────────────────────────────────────── data views

const selectServices = (s: Snapshot) => s.services;

function ContainerRow({ c, ip, addrs, service }: { c: DockerContainer; ip?: string; addrs: readonly string[]; service?: ServiceEntry }) {
  const state = toneOf.container(c);
  const ports = publishedPorts(c);
  const running = c.state === 'running';
  // the launcher's URL for this app: used for its own port (keeps https and paths), or as an extra link when it goes
  // through a reverse-proxy name (services.overrides)
  const appUrl = running ? service?.url : undefined;
  const proxied = proxiedAppUrl(appUrl, addrs);
  return (
    <li className="gd-ctr">
      <AppIcon icon={containerIconSlug(c, service?.icon)} name={c.composeService || c.name} size={36} />
      <div className="gd-ctr-main">
        <div className="gd-ctr-top">
          <span className="gd-ctr-name">{c.name}</span>
          <StatusBadge {...state} size="small" />
        </div>
        <div className="gd-ctr-image" title={c.image}>
          {c.image}
        </div>
        <div className="gd-ctr-meta">
          <span>{containerStatusText(c)}</span>
          {(ports.length > 0 || proxied) && (
            <span className="gd-ports">
              {proxied && (
                <a className="gd-port" data-app href={proxied} target="_blank" rel="noopener noreferrer" title={`Open ${proxied}`}>
                  {urlLabel(proxied)}
                  <ArrowUpRight size={11} strokeWidth={2.6} aria-hidden="true" />
                </a>
              )}
              {ports.map((p) => {
                const url = running ? portLink(p, ip, appUrl, addrs) : undefined;
                const label = p.proto === 'udp' ? `${p.hostPort}/udp` : String(p.hostPort);
                const title = `${p.hostIp && p.hostIp !== '0.0.0.0' && p.hostIp !== '::' ? `${p.hostIp}:` : ''}${p.hostPort} → ${p.containerPort}/${p.proto}`;
                return url ? (
                  <a
                    key={`${p.hostPort}/${p.proto}`}
                    className="gd-port"
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open ${url} (${title})`}
                  >
                    {label}
                    <ArrowUpRight size={11} strokeWidth={2.6} aria-hidden="true" />
                  </a>
                ) : (
                  <span key={`${p.hostPort}/${p.proto}`} className="gd-port" data-plain title={title}>
                    {label}
                  </span>
                );
              })}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/** "jellyfin.bgreen.cloud" for a link chip (host, plus the path when there is one). */
function urlLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '';
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

function groupSummary(g: ContainerGroup): string {
  const unhealthy = g.containers.filter((c) => c.health === 'unhealthy').length;
  const stopped = g.containers.filter((c) => c.state !== 'running').length;
  const parts = [plural(g.containers.length, 'container')];
  if (!unhealthy && !stopped) parts.push(g.containers.length > 1 ? 'all running' : 'running');
  if (unhealthy) parts.push(`${unhealthy} unhealthy`);
  if (stopped) parts.push(`${stopped} not running`);
  return parts.join(' · ');
}

function DockerSection({ inv, guest }: { inv: GuestInventory; guest: Guest }) {
  const services = useSnapshot(selectServices, Object.is);
  const groups = useMemo(() => groupContainers(inv.containers ?? []), [inv.containers]);
  const ip = primaryIp(guest, inv);
  const addrs = useMemo(() => guestAddresses(guest, inv).map((a) => a.address), [guest, inv]);

  if (!inv.containers?.length) {
    if (!inv.dockerPresent) return null;
    return (
      <Card title="Docker" icon={<Layers size={16} strokeWidth={2.2} />} iconColor="var(--blue)">
        <p className="gd-empty-note gd-empty-note-inline">Docker is installed, but there are no containers.</p>
      </Card>
    );
  }
  return (
    <section className="gd-section" aria-label="Docker containers">
      <h2 className="gd-section-title">
        Docker <span>{plural(inv.containers.length, 'container')}</span>
      </h2>
      <div className="gd-groups">
        {groups.map((g) => (
          <Card
            key={g.project ?? '\u0000standalone'}
            data-n={Math.min(g.containers.length, 3)}
            title={g.project ?? 'Standalone'}
            subtitle={groupSummary(g)}
            icon={<Layers size={16} strokeWidth={2.2} />}
            iconColor={g.problems ? 'var(--status-warn)' : 'var(--blue)'}
            headingLevel={3}
          >
            <ul className="gd-ctrs">
              {g.containers.map((c) => (
                <ContainerRow key={c.id || c.name} c={c} ip={ip} addrs={addrs} service={containerService(services, guest.vmid, c)} />
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </section>
  );
}

function ServicesCard({ inv }: { inv: GuestInventory }) {
  const [showSystem, setShowSystem] = useState(false);
  const all = inv.services ?? [];
  const systemCount = all.filter((s) => s.system).length;
  const shown = (showSystem ? all : all.filter((s) => !s.system))
    .slice()
    .sort((a, b) => Number(a.system) - Number(b.system) || a.unit.localeCompare(b.unit));
  const init = inv.initSystem && inv.initSystem !== 'unknown' ? inv.initSystem : undefined;
  return (
    <Card
      title="Services"
      subtitle={[plural(all.length - systemCount, 'app service'), init].filter(Boolean).join(' · ')}
      padding="none"
      className="gd-list"
      icon={<ScrollText size={16} strokeWidth={2.2} />}
      iconColor="var(--indigo)"
      footer={
        systemCount > 0 ? (
          <Toggle size="small" label={`Show system services (${systemCount})`} checked={showSystem} onChange={setShowSystem} className="gd-toggle" />
        ) : undefined
      }
    >
      {shown.length === 0 ? (
        <p className="gd-empty-note">{all.length ? 'Only system services are running.' : 'No running services were found.'}</p>
      ) : (
        <ListGroup plain ariaLabel="Running services">
          {shown.map((s) => {
            const running = !s.sub || s.sub === 'running' || s.sub === 'started';
            return (
              <div key={s.unit} className="ui-row" role="listitem" data-dense>
                <span className="ui-row-text">
                  <span className="ui-row-title">{s.unit}</span>
                  {s.description && s.description !== s.unit && <span className="ui-row-subtitle">{s.description}</span>}
                </span>
                {s.system && <span className="gd-chip">System</span>}
                {!running && <StatusBadge tone="warn" size="small" label={s.sub!} />}
              </div>
            );
          })}
        </ListGroup>
      )}
    </Card>
  );
}

function bindLabel(address: string): ReactNode {
  if (address === '0.0.0.0') return <span className="t-label-2">All IPv4</span>;
  if (address === '*') return <span className="t-label-2">All addresses</span>;
  if (address === '::' || address === '[::]') return <span className="t-label-2">All IPv6</span>;
  if (/^127\.|^::1$|^\[::1\]$|^localhost$/.test(address))
    return (
      <span className="gd-chip" title={`${address}: reachable only from inside the guest`}>
        Local only
      </span>
    );
  return <span className="t-mono">{address}</span>;
}

const PORT_COLUMNS: TableColumn<ListeningPort>[] = [
  {
    key: 'port',
    header: 'Port',
    align: 'right',
    sortValue: (p) => p.port,
    defaultDir: 'asc',
    cell: (p) => (
      <span className="t-mono t-semibold">
        {p.port}
        {p.proto !== 'tcp' && <span className="t-label-3">/{p.proto}</span>}
      </span>
    ),
  },
  { key: 'proto', header: 'Proto', hideBelow: 'iphone', sortValue: (p) => p.proto, cell: (p) => p.proto.toUpperCase() },
  { key: 'address', header: 'Bound to', sortValue: (p) => p.address, cell: (p) => bindLabel(p.address) },
  {
    key: 'process',
    header: 'Process',
    sortValue: (p) => p.process ?? '',
    truncate: 140,
    cell: (p) =>
      p.process ? (
        <span title={p.pid ? `PID ${p.pid}` : undefined}>
          {p.process}
          {p.pid ? <span className="t-label-3"> · {p.pid}</span> : null}
        </span>
      ) : (
        <span className="t-label-3">–</span>
      ),
  },
];

function PortsCard({ inv }: { inv: GuestInventory }) {
  // ss lists IPv4 and IPv6 sockets separately; keep one row per port/proto/address/process
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return (inv.ports ?? []).filter((p) => {
      const k = `${p.proto}/${p.port}/${p.address}/${p.process ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [inv.ports]);
  return (
    <Card
      title="Listening ports"
      subtitle={plural(rows.length, 'socket')}
      padding="none"
      icon={<Plug size={16} strokeWidth={2.2} />}
      iconColor="var(--teal)"
    >
      <Table
        caption="Listening ports"
        dense
        columns={PORT_COLUMNS}
        rows={rows}
        rowKey={(p) => `${p.proto}/${p.port}/${p.address}/${p.process ?? ''}`}
        initialSort={{ key: 'port', dir: 'asc' }}
        emptyMessage="No listening TCP ports were found."
      />
    </Card>
  );
}

function FreshnessBar({
  inv,
  onRefresh,
  refreshing,
  stale,
}: {
  inv: GuestInventory;
  onRefresh?: () => void;
  refreshing: boolean;
  stale?: ReactNode;
}) {
  const os = inv.os?.prettyName ?? inv.os?.name;
  return (
    <div className="gd-fresh">
      <span className="gd-fresh-text">
        Collected <RelativeTime time={inv.collectedAt} format="long" /> via {sourceLabel(inv.source)}
        {os ? ` · ${os}` : ''}
        {inv.kernel ? ` · kernel ${inv.kernel}` : ''}
      </span>
      {stale}
      {onRefresh && (
        <Button variant="plain" size="small" icon={<RefreshCw size={14} strokeWidth={2.2} />} loading={refreshing} onClick={onRefresh}>
          Refresh
        </Button>
      )}
    </div>
  );
}

function InventoryData({
  guest,
  inv,
  onRefresh,
  refreshing,
  banner,
}: {
  guest: Guest;
  inv: GuestInventory;
  onRefresh?: () => void;
  refreshing: boolean;
  banner?: ReactNode;
}) {
  return (
    <div className="gd-apps">
      <FreshnessBar inv={inv} onRefresh={onRefresh} refreshing={refreshing} />
      {banner}
      <DockerSection inv={inv} guest={guest} />
      <div className="gd-grid">
        <ServicesCard inv={inv} />
        <PortsCard inv={inv} />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── tab

export function AppsTab({ guest, inv, meta, onRefresh, refreshing }: AppsTabProps) {
  const view = inventoryView(guest, inv, { enabled: meta.inventoryEnabled, collectors: meta.collectors });
  const refreshAction = (
    <Button variant="gray" size="small" icon={<RefreshCw size={14} strokeWidth={2.2} />} loading={refreshing} onClick={onRefresh}>
      Try Again
    </Button>
  );

  switch (view.kind) {
    case 'disabled':
      return (
        <Unavailable icon={PackageX} title="Apps & services inventory is off">
          <span className="gd-msg">
            pve1-dash can list Docker containers, services and open ports inside your guests over a read-only SSH helper. Turn it on with{' '}
            <code>inventory.enabled: true</code> in config.yaml and install the host helper (see Settings → Data sources).
          </span>
        </Unavailable>
      );
    case 'template':
      return (
        <Unavailable icon={Layers} title="Templates aren’t inspected">
          <span className="gd-msg">A template never runs, so there are no apps to list. Guests cloned from it show theirs once they run.</span>
        </Unavailable>
      );
    case 'stopped':
      if (view.stale) {
        return (
          <InventoryData
            guest={guest}
            inv={view.stale}
            refreshing={refreshing}
            banner={
              <div className="gd-banner" data-tone="off">
                <CirclePause size={16} strokeWidth={2.2} aria-hidden="true" />
                <span>{guest.name} is stopped. This is what was running when it was last inspected; pve1-dash only looks inside running guests.</span>
              </div>
            }
          />
        );
      }
      return (
        <Unavailable icon={MonitorOff} title={`${guest.name} isn’t running`}>
          <span className="gd-msg">
            pve1-dash only looks inside running guests, and never starts them. Its apps and services appear here once it runs.
          </span>
        </Unavailable>
      );
    case 'windows':
      return (
        <Unavailable icon={ShieldOff} title="Windows isn’t supported">
          <span className="gd-msg">
            The inventory helper is a POSIX shell script, so it can only look inside Linux and BSD guests. Resources, IPs and backups still work.
          </span>
          <RawError text={view.error} />
        </Unavailable>
      );
    case 'unsupported':
      return (
        <Unavailable icon={EyeOff} title={view.reason.title}>
          <span className="gd-msg">{view.reason.message}</span>
          <RawError text={view.reason.raw} />
        </Unavailable>
      );
    case 'no-agent': {
      const ip = primaryIp(guest, inv);
      return (
        <Card className="gd-unavailable">
          <EmptyState
            icon={<Unplug size={26} strokeWidth={1.9} />}
            title="No guest agent"
            message={
              <span className="gd-msg">
                This VM has no QEMU guest agent enabled, so pve1 can’t ask it what’s running. Either install <code>qemu-guest-agent</code> in the VM
                and turn on <em>Options → QEMU Guest Agent</em> in Proxmox, or let pve1-dash reach it directly over SSH:
              </span>
            }
          />
          <ol className="gd-steps">
            <li>
              <span>
                Run this as root inside the VM. It installs a read-only inventory helper and authorizes the dashboard’s key for that helper only:
              </span>
              <CodeBlock label="guest setup command" text={guestSetupCommand(meta.publicUrl)} />
            </li>
            <li>
              <span>Add the VM to config.yaml on the dashboard and restart it:</span>
              <CodeBlock label="config.yaml snippet" text={directSshSnippet(guest.vmid, ip)} />
            </li>
          </ol>
        </Card>
      );
    }
    case 'pending':
      return (
        <Unavailable
          icon={CircleAlert}
          title="Not collected yet"
          action={
            <Button variant="gray" size="small" icon={<RefreshCw size={14} strokeWidth={2.2} />} loading={refreshing} onClick={onRefresh}>
              Collect Now
            </Button>
          }
        >
          <span className="gd-msg">
            The inventory sweep visits every running guest every few minutes. Collect now to see this guest’s apps right away.
          </span>
          {view.sweepError && (
            <span className="gd-msg gd-msg-warn">
              <TriangleAlert size={14} strokeWidth={2.2} aria-hidden="true" /> The last sweep failed: {view.sweepError}
            </span>
          )}
        </Unavailable>
      );
    case 'error':
      return (
        <div className="gd-apps">
          <FreshnessBar inv={view.inv} onRefresh={onRefresh} refreshing={refreshing} />
          <ReasonView reason={view.reason} action={refreshAction} />
        </div>
      );
    case 'ok':
      return (
        <InventoryData
          guest={guest}
          inv={view.inv}
          onRefresh={onRefresh}
          refreshing={refreshing}
          banner={
            view.failed ? (
              <div className="gd-banner" data-tone="warn">
                <TriangleAlert size={16} strokeWidth={2.2} aria-hidden="true" />
                <span>
                  The latest refresh failed: {view.failed.title}. Showing what was collected before.
                  {view.failed.raw ? <code className="gd-banner-raw">{view.failed.raw}</code> : null}
                </span>
              </div>
            ) : undefined
          }
        />
      );
  }
}
