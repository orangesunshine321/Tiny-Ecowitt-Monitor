/**
 * The Guests list view on iPhone: an inset-grouped list (OS icon, name, "CT 101 · 10.10.20.2", CPU and a memory bar,
 * a status dot, chevron) instead of the desktop table squeezed into the phone's width.
 */
import { memo } from 'react';
import type { Guest, GuestInventory } from '../../../../shared/types';
import { ListGroup, ListRow, Meter, OsIcon, StatusDot, toneOf } from '../../components';
import { formatBytesOf, formatPercent } from '../../format';
import { UpdateFlags } from './GuestBits';
import { fraction, guestUpdates, primaryIp, typeLabel, typeName } from './guestUtil';

const GuestListRow = memo(function GuestListRow({ guest: g, inventory }: { guest: Guest; inventory?: GuestInventory }) {
  const running = g.status === 'running';
  const status = g.template ? { tone: 'off' as const, label: 'Template' } : toneOf.guest(g.status);
  const ip = primaryIp(g, inventory);
  const mem = fraction(g.mem, g.maxmem);
  const os = g.osName ?? inventory?.os?.prettyName;
  return (
    <ListRow
      className={running ? 'gx-lrow' : 'gx-lrow gx-lrow-off'}
      href={`/guests/${g.vmid}`}
      icon={<OsIcon os={os} ostype={g.config?.ostype} type={g.type} size={30} className="gx-lrow-os" />}
      title={
        <span className="gx-lrow-title">
          <span className="t-truncate">{g.name}</span>
          <UpdateFlags info={g.template ? undefined : guestUpdates(inventory)} compact />
        </span>
      }
      subtitle={
        <span title={`${typeName(g.type)} ${g.vmid}`}>
          {typeLabel(g.type)} {g.vmid}
          {' · '}
          {ip ? <span className="t-mono gx-lrow-ip">{ip}</span> : running ? 'No address' : status.label}
        </span>
      }
      value={
        running ? (
          <span className="gx-lrow-usage">
            <span className="gx-lrow-k">CPU</span>
            <span className="gx-lrow-v">{formatPercent(g.cpu)}</span>
            <span className="gx-lrow-k">Mem</span>
            <Meter value={mem} size="small" valueLabel={null} ariaLabel={`Memory ${formatBytesOf(g.mem, g.maxmem)}`} className="gx-lrow-bar" />
          </span>
        ) : undefined
      }
      accessory={<StatusDot tone={status.tone} label={status.label} className="gx-lrow-dot" />}
    />
  );
});

export function GuestList({ guests, inventory }: { guests: Guest[]; inventory: Record<string, GuestInventory> }) {
  return (
    <ListGroup ariaLabel="Guests" className="gx-list">
      {guests.map((g) => (
        <GuestListRow key={g.vmid} guest={g} inventory={inventory[String(g.vmid)]} />
      ))}
    </ListGroup>
  );
}
