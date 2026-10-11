/** Building blocks of the Network page: interface cards, physical device list, guest address and open-port tables. */
import { Cable, EthernetPort, Merge, Network, Tags, Waypoints, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';
import type { Guest, NetworkInterface } from '../../../../shared/types';
import { Card, ListGroup, ListRow, StatusBadge, Table, type TableColumn } from '../../components';
import { plural } from '../../format';
import { Facts, Pill, TwoLine, type Fact } from '../storage/ui';
import { guestsOnBridge, ifaceTypeLabel, methodLabel, parentOf, type AddressRow, type PortRow } from './networkModel';

const ICONS: Record<string, LucideIcon> = {
  bridge: Network,
  OVSBridge: Network,
  bond: Merge,
  OVSBond: Merge,
  vlan: Tags,
  vnet: Waypoints,
  eth: EthernetPort,
};

const typeNoun = (t: string | undefined) => (t === 'lxc' ? 'CT' : t === 'qemu' ? 'VM' : 'Guest');
const yes = (v: boolean | undefined) => (v ? 'Yes' : 'No');
const MAX_GUEST_PILLS = 10;

function activeBadge(i: NetworkInterface) {
  return i.active ? <StatusBadge tone="ok" label="Active" size="small" /> : <StatusBadge tone="off" label="Down" size="small" />;
}

/** Card for a bridge, bond, VLAN or other virtual interface. */
export function InterfaceCard({ iface, all, guests }: { iface: NetworkInterface; all: readonly NetworkInterface[]; guests: readonly Guest[] }) {
  const Icon = ICONS[iface.type] ?? Cable;
  const attached = iface.type === 'bridge' || iface.type === 'OVSBridge' ? guestsOnBridge(iface.iface, guests) : [];
  const parent = parentOf(iface.iface, all);
  const facts: (Fact | null)[] = [
    iface.cidr ? { label: 'IPv4', value: iface.cidr, mono: true } : null,
    iface.gateway ? { label: 'Gateway', value: iface.gateway, mono: true } : null,
    iface.cidr6 ? { label: 'IPv6', value: iface.cidr6, mono: true } : null,
    iface.gateway6 ? { label: 'IPv6 gateway', value: iface.gateway6, mono: true } : null,
    iface.bridgePorts !== undefined
      ? {
          label: 'Ports',
          value: iface.bridgePorts.length ? (
            <span className="inf-pills net-pills-end">
              {iface.bridgePorts.map((p) => (
                <Pill key={p} mono>
                  {p}
                </Pill>
              ))}
            </span>
          ) : (
            <span className="inf-muted">None</span>
          ),
        }
      : null,
    iface.type === 'bridge' || iface.type === 'OVSBridge' ? { label: 'VLAN aware', value: yes(iface.bridgeVlanAware) } : null,
    iface.bondSlaves?.length
      ? {
          label: 'Slaves',
          value: (
            <span className="inf-pills net-pills-end">
              {iface.bondSlaves.map((p) => (
                <Pill key={p} mono>
                  {p}
                </Pill>
              ))}
            </span>
          ),
        }
      : null,
    iface.bondMode ? { label: 'Bond mode', value: iface.bondMode, mono: true } : null,
    iface.vlanId !== undefined ? { label: 'VLAN tag', value: String(iface.vlanId) } : null,
    iface.vlanRawDevice ? { label: 'Raw device', value: iface.vlanRawDevice, mono: true } : null,
    parent ? { label: 'Part of', value: parent.iface, mono: true } : null,
    iface.mtu !== undefined ? { label: 'MTU', value: String(iface.mtu) } : null,
    { label: 'Autostart', value: yes(iface.autostart) },
  ];
  return (
    <Card
      className="net-card inf-card-tight"
      title={iface.iface}
      subtitle={[ifaceTypeLabel(iface.type), methodLabel(iface.method)].filter(Boolean).join(' · ')}
      icon={<Icon size={16} strokeWidth={2.2} />}
      iconColor="var(--gray)"
      accessory={activeBadge(iface)}
    >
      {iface.comments && <p className="net-comment">{iface.comments}</p>}
      <Facts items={facts} />
      {attached.length > 0 && (
        <div className="net-attached">
          <div className="net-attached-label">{plural(attached.length, 'guest')} connected</div>
          <div className="inf-pills">
            {attached.slice(0, MAX_GUEST_PILLS).map((g) => (
              <Pill key={g.vmid} title={`${typeNoun(g.type)} ${g.vmid}`}>
                {g.name}
              </Pill>
            ))}
            {attached.length > MAX_GUEST_PILLS && <Pill>+{attached.length - MAX_GUEST_PILLS} more</Pill>}
          </div>
        </div>
      )}
    </Card>
  );
}

/** Physical NICs as one inset list: link state and which bridge/bond uses them. */
export function DevicesCard({ devices, all }: { devices: readonly NetworkInterface[]; all: readonly NetworkInterface[] }) {
  return (
    <Card className="net-card inf-card-tight" title="Network devices" subtitle={plural(devices.length, 'physical interface')} icon={<EthernetPort size={16} strokeWidth={2.2} />} iconColor="var(--gray)" padding="none">
      <ListGroup plain ariaLabel="Physical network devices">
        {devices.map((d) => {
          const parent = parentOf(d.iface, all);
          const sub = [parent ? `Port of ${parent.iface}` : 'Not in a bridge', d.cidr, d.mtu !== undefined ? `MTU ${d.mtu}` : undefined, d.comments].filter(Boolean).join(' · ');
          return <ListRow key={d.iface} dense title={<span className="inf-mono net-dev-name">{d.iface}</span>} subtitle={sub} value={activeBadge(d)} />;
        })}
      </ListGroup>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── guest addresses

function Lines({ items, mono, empty }: { items: (string | undefined)[]; mono?: boolean; empty?: string }) {
  if (!items.length) return <span className="inf-muted">{empty ?? '–'}</span>;
  return (
    <span className="inf-lines">
      {items.map((v, i) => (
        <span key={i} className={mono && v ? 'inf-mono' : v ? undefined : 'inf-muted'}>
          {v ?? '–'}
        </span>
      ))}
    </span>
  );
}

function AddressList({ row }: { row: AddressRow }) {
  if (!row.addresses.length) {
    const text = row.dhcp ? 'DHCP' : row.status !== 'running' ? 'Not running' : 'No address reported';
    return <span className="inf-muted">{text}</span>;
  }
  return (
    <span className="inf-lines">
      {row.addresses.map((a) => (
        <span key={a.address} className="net-addr" title={`${a.address}${a.prefix !== undefined ? `/${a.prefix}` : ''} · from ${sourceLabel(a.source)}`}>
          <span className="inf-mono">
            {a.address}
            {a.prefix !== undefined && <span className="t-label-3">/{a.prefix}</span>}
          </span>
          {a.iface && <span className="net-addr-iface">{a.iface}</span>}
        </span>
      ))}
    </span>
  );
}

function sourceLabel(s: string): string {
  return s === 'guest-agent' ? 'the guest agent' : s === 'lxc-interfaces' ? 'the container' : s === 'inventory' ? 'the inventory helper' : 'the guest config';
}

export function AddressTable({ rows }: { rows: readonly AddressRow[] }) {
  const columns = useMemo<TableColumn<AddressRow>[]>(
    () => [
      {
        key: 'guest',
        header: 'Guest',
        sortValue: (r) => r.name,
        cell: (r) => (
          <TwoLine
            title={r.name}
            subtitle={
              <>
                {typeNoun(r.type)} {r.vmid}
                {r.status !== 'running' && ` · ${r.status}`}
                <span className="inf-only-iphone">{r.nics.length ? ` · ${[...new Set(r.nics.map((n) => n.bridge).filter(Boolean))].join(', ')}` : ''}</span>
              </>
            }
          />
        ),
      },
      { key: 'ip', header: 'Addresses', wrap: true, sortValue: (r) => r.sortKey, defaultDir: 'asc', cell: (r) => <AddressList row={r} /> },
      { key: 'mac', header: 'MAC', hideBelow: 'iphone', sortValue: (r) => r.nics[0]?.mac, cell: (r) => <Lines items={r.nics.map((n) => n.mac)} mono /> },
      {
        key: 'bridge',
        header: 'Bridge',
        hideBelow: 'iphone',
        sortValue: (r) => r.nics[0]?.bridge,
        cell: (r) => <Lines items={r.nics.map((n) => (n.bridge ? `${n.bridge}${n.linkDown ? ' (link down)' : ''}` : undefined))} />,
      },
      {
        key: 'vlan',
        header: 'VLAN',
        align: 'right',
        hideBelow: 'iphone',
        sortValue: (r) => r.nics[0]?.vlan,
        cell: (r) => <Lines items={r.nics.map((n) => (n.vlan !== undefined ? String(n.vlan) : undefined))} />,
      },
    ],
    [],
  );
  return (
    <Table
      caption="Guest network addresses"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.vmid}
      rowHref={(r) => `/guests/${r.vmid}`}
      emptyMessage="No guest matches the search"
    />
  );
}

// ───────────────────────────────────────────────────────────── open ports

function scopeText(r: PortRow): string {
  return r.scope === 'all' ? 'All interfaces' : r.scope === 'loopback' ? 'Localhost only' : r.address;
}

export function PortsTable({ rows }: { rows: readonly PortRow[] }) {
  const columns = useMemo<TableColumn<PortRow>[]>(
    () => [
      {
        key: 'port',
        header: 'Port',
        sortValue: (r) => r.port,
        defaultDir: 'asc',
        cell: (r) => (
          <span className="net-port">
            <span className="inf-mono net-port-n">{r.port}</span>
            <span className="net-proto">{r.proto}</span>
          </span>
        ),
      },
      {
        key: 'guest',
        header: 'Guest',
        sortValue: (r) => r.guest,
        cell: (r) => (
          <TwoLine
            title={r.guest}
            subtitle={
              <>
                {typeNoun(r.guestType)} {r.vmid}
                <span className="inf-only-iphone"> · {scopeText(r)}</span>
              </>
            }
          />
        ),
      },
      {
        key: 'address',
        header: 'Listening on',
        hideBelow: 'iphone',
        sortValue: (r) => (r.scope === 'all' ? '' : r.address),
        cell: (r) => (r.scope === 'specific' ? <span className="inf-mono">{r.address}</span> : <span className={r.scope === 'loopback' ? 't-label-2' : undefined}>{scopeText(r)}</span>),
      },
      {
        key: 'process',
        header: 'Process',
        truncate: 160,
        shrink: true,
        sortValue: (r) => r.container ?? r.process,
        cell: (r) =>
          r.container ? (
            <TwoLine title={r.container} subtitle={r.process ? `${r.process} · Docker` : 'Docker'} />
          ) : r.process ? (
            <span className="inf-mono">{r.process}</span>
          ) : (
            <span className="inf-muted">–</span>
          ),
      },
    ],
    [],
  );
  return <Table caption="Open ports across guests" columns={columns} rows={rows} rowKey={(r) => r.key} rowHref={(r) => `/guests/${r.vmid}`} emptyMessage="No open port matches the search" />;
}
