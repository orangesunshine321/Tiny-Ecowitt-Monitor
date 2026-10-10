/**
 * Network (DESIGN §5): host interfaces and bridges (type, CIDR, gateway, ports, VLAN-aware, connected guests), the
 * guest address table (guests[].ips merged with static config addresses, MAC, bridge, VLAN) and a searchable table of
 * open ports across all guests from the apps & services inventory.
 */
import { Network as NetworkIcon, Radar } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Card, CardGrid, EmptyState, PageHeader, Toggle } from '../components';
import { plural } from '../format';
import { useSnapshot } from '../store';
import { AddressTable, DevicesCard, InterfaceCard, PortsTable } from './network/NetworkParts';
import {
  guestAddressRows,
  inventoryCoverage,
  isPhysical,
  matchesAddressQuery,
  matchesPortQuery,
  openPortRows,
  sortInterfaces,
} from './network/networkModel';
import { SearchField, Section, useCollectorIssue } from './storage/ui';
import './storage/ui.css';
import './network/network.css';

export default function NetworkPage() {
  const network = useSnapshot((s) => s.network, Object.is);
  const guests = useSnapshot((s) => s.guests, Object.is);
  const inventory = useSnapshot((s) => s.inventory, Object.is);
  const inventoryEnabled = useSnapshot((s) => s.meta.inventoryEnabled);
  const networkIssue = useCollectorIssue('network');

  const sorted = useMemo(() => sortInterfaces(network), [network]);
  const virtual = sorted.filter((i) => !isPhysical(i));
  const physical = sorted.filter(isPhysical);

  const [addrQuery, setAddrQuery] = useState('');
  const addressRows = useMemo(() => guestAddressRows(guests), [guests]);
  const visibleAddresses = useMemo(() => addressRows.filter((r) => matchesAddressQuery(r, addrQuery)), [addressRows, addrQuery]);

  const [portQuery, setPortQuery] = useState('');
  const [localhost, setLocalhost] = useState(false);
  const portRows = useMemo(() => openPortRows(inventory, guests, { includeLoopback: localhost }), [inventory, guests, localhost]);
  const visiblePorts = useMemo(() => portRows.filter((r) => matchesPortQuery(r, portQuery)), [portRows, portQuery]);
  const coverage = useMemo(() => inventoryCoverage(inventory, guests), [inventory, guests]);

  const primary = sorted.find((i) => i.gateway && i.cidr) ?? sorted.find((i) => i.cidr);
  const subtitle = [
    primary ? `${primary.iface} · ${primary.cidr}` : '',
    plural(network.length, 'interface'),
    plural(addressRows.length, 'guest'),
  ]
    .filter(Boolean)
    .join(' · ');

  const coverageNote = [
    coverage.ok ? `Collected from ${plural(coverage.ok, 'running guest')}.` : '',
    coverage.failed.length ? `No data from ${coverage.failed.map((f) => (f.error ? `${f.name} (${f.error})` : f.name)).join(', ')}.` : '',
    coverage.missing ? `${plural(coverage.missing, 'running guest')} not inventoried yet.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <PageHeader title="Network" subtitle={subtitle} />
      <div className="inf-page">
        <Section id="interfaces" title="Interfaces" subtitle="Host network configuration of the node">
          {sorted.length ? (
            <CardGrid min={320}>
              {virtual.map((i) => (
                <InterfaceCard key={i.iface} iface={i} all={network} guests={guests} />
              ))}
              {physical.length > 0 && <DevicesCard devices={physical} all={network} />}
            </CardGrid>
          ) : (
            <Card>
              <EmptyState compact icon={<NetworkIcon size={24} strokeWidth={1.8} />} title="No interfaces reported" message={networkIssue ?? 'Proxmox VE returned no network configuration for this node.'} />
            </Card>
          )}
        </Section>

        <Section
          id="addresses"
          title="Guest addresses"
          subtitle="Live addresses from guests, plus static addresses from their configuration"
          accessory={<SearchField value={addrQuery} onChange={setAddrQuery} placeholder="Search name, IP or MAC" />}
        >
          <Card padding="none" className="net-table">
            {addressRows.length ? (
              <AddressTable rows={visibleAddresses} />
            ) : (
              <EmptyState compact title="No guests" message="There are no virtual machines or containers on this node." />
            )}
          </Card>
        </Section>

        <Section
          id="ports"
          title="Open ports"
          subtitle={inventoryEnabled ? `${plural(portRows.length, 'listening port')} across guests` : undefined}
          accessory={
            inventoryEnabled ? (
              <>
                <SearchField value={portQuery} onChange={setPortQuery} placeholder="Search port, guest or process" />
                <Toggle size="small" label="Include localhost" checked={localhost} onChange={setLocalhost} className="net-toggle" />
              </>
            ) : undefined
          }
        >
          <Card padding="none" className="net-table" footer={inventoryEnabled && coverageNote ? coverageNote : undefined}>
            {!inventoryEnabled ? (
              <EmptyState
                compact
                icon={<Radar size={24} strokeWidth={1.8} />}
                title="Inventory is off"
                message="Open ports come from the apps & services inventory over SSH. Enable it in config.yaml to see them here."
              />
            ) : portRows.length ? (
              <PortsTable rows={visiblePorts} />
            ) : (
              <EmptyState
                compact
                icon={<Radar size={24} strokeWidth={1.8} />}
                title="No open ports yet"
                message="No guest has reported listening sockets. They appear after the next inventory run."
              />
            )}
          </Card>
        </Section>
      </div>
    </>
  );
}
