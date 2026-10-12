/** Guest detail → Hardware: CPU, memory, firmware/options, disks and NICs from the guest config. */
import { Cable, Cpu, HardDrive, Settings2 } from 'lucide-react';
import type { Guest } from '../../../../../shared/types';
import { Card, EmptyState, ListGroup, ListRow, StatusBadge } from '../../../components';
import { formatBytes, plural } from '../../../format';

/** PVE ostype codes (QEMU: pve-api-guests.md §qemu config; LXC: the distribution name). */
const OSTYPE: Record<string, string> = {
  l26: 'Linux 2.6 – 6.x kernel',
  l24: 'Linux 2.4 kernel',
  win11: 'Windows 11 / 2022 / 2025',
  win10: 'Windows 10 / 2016 / 2019',
  win8: 'Windows 8 / 2012',
  win7: 'Windows 7 / 2008 R2',
  wvista: 'Windows Vista / 2008',
  w2k8: 'Windows 2008',
  w2k3: 'Windows 2003',
  w2k: 'Windows 2000',
  wxp: 'Windows XP',
  solaris: 'Solaris',
  other: 'Other',
  debian: 'Debian',
  devuan: 'Devuan',
  ubuntu: 'Ubuntu',
  centos: 'CentOS / Rocky / Alma',
  fedora: 'Fedora',
  opensuse: 'openSUSE',
  archlinux: 'Arch Linux',
  alpine: 'Alpine',
  gentoo: 'Gentoo',
  nixos: 'NixOS',
  unmanaged: 'Unmanaged',
};

const yesNo = (v: boolean | undefined) => (v === undefined ? undefined : v ? 'Yes' : 'No');

function Row({ title, value, mono }: { title: string; value: string | number | undefined | null; mono?: boolean }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <ListRow
      dense
      title={title}
      value={
        <span className={`gd-val ${mono ? 't-mono' : ''}`} title={String(value)}>
          {value}
        </span>
      }
    />
  );
}

export function HardwareTab({ guest: g }: { guest: Guest }) {
  const c = g.config;
  if (!c) {
    return (
      <Card className="gd-unavailable">
        <EmptyState
          icon={<Settings2 size={26} strokeWidth={1.9} />}
          title="Configuration not loaded yet"
          message="pve1-dash reads guest configs every couple of minutes. Check back shortly."
        />
      </Card>
    );
  }
  const qemu = g.type === 'qemu';
  const vcpus = c.cores && c.sockets ? c.cores * c.sockets : (c.cores ?? g.cpus);
  const cpuText =
    qemu && c.sockets && c.cores ? `${plural(vcpus, 'vCPU')} (${plural(c.sockets, 'socket')} × ${plural(c.cores, 'core')})` : plural(vcpus, 'core');
  const balloon = c.balloonBytes === undefined ? undefined : c.balloonBytes === 0 ? 'Off' : `${formatBytes(c.balloonBytes)} minimum`;
  const bios = c.bios === 'ovmf' ? 'OVMF (UEFI)' : c.bios === 'seabios' ? 'SeaBIOS' : c.bios;
  const viewers = qemu ? [c.hasSerial ? 'serial' : '', c.hasSpice ? 'SPICE' : '', 'noVNC'].filter(Boolean).join(' · ') : undefined;

  return (
    <div className="gd-grid">
      <Card title="Processor & memory" padding="none" className="gd-list" icon={<Cpu size={16} strokeWidth={2.2} />} iconColor="var(--blue)">
        <ListGroup plain ariaLabel="Processor and memory">
          <Row title="CPU" value={cpuText} />
          <Row title="CPU type" value={c.cpuType} mono />
          <Row title="Memory" value={c.memoryBytes !== undefined ? formatBytes(c.memoryBytes) : formatBytes(g.maxmem)} />
          {qemu && <Row title="Ballooning" value={balloon} />}
          {!qemu && <Row title="Swap" value={c.swapBytes !== undefined ? formatBytes(c.swapBytes) : undefined} />}
          {!qemu && <Row title="Architecture" value={c.arch} />}
        </ListGroup>
      </Card>

      <Card title="System" padding="none" className="gd-list" icon={<Settings2 size={16} strokeWidth={2.2} />} iconColor="var(--gray)">
        <ListGroup plain ariaLabel="System options">
          <Row title="OS type" value={c.ostype ? (OSTYPE[c.ostype] ?? c.ostype) : undefined} />
          {qemu && <Row title="Firmware" value={bios} />}
          {qemu && <Row title="Machine" value={c.machine} mono />}
          {qemu && <Row title="QEMU guest agent" value={c.agentEnabled === undefined ? undefined : c.agentEnabled ? 'Enabled' : 'Disabled'} />}
          {qemu && <Row title="Console" value={viewers} />}
          {!qemu && <Row title="Unprivileged" value={yesNo(c.unprivileged)} />}
          {!qemu && <Row title="Features" value={c.features} mono />}
          <Row title="Start at boot" value={yesNo(c.onboot)} />
          <Row title="Startup order" value={c.startup} mono />
        </ListGroup>
      </Card>

      <Card
        title="Disks"
        subtitle={c.disks.length ? plural(c.disks.length, 'disk') : undefined}
        padding="none"
        className="gd-list"
        icon={<HardDrive size={16} strokeWidth={2.2} />}
        iconColor="var(--indigo)"
      >
        {c.disks.length === 0 ? (
          <p className="gd-empty-note">No disks in the configuration.</p>
        ) : (
          <ListGroup plain ariaLabel="Disks">
            {c.disks.map((d) => (
              <div key={d.key} className="ui-row" role="listitem" data-wrap>
                <span className="ui-row-text">
                  <span className="ui-row-title gd-hw-title">
                    <span className="gd-key">{d.key}</span>
                    {d.mountPoint && <span className="t-mono">{d.mountPoint}</span>}
                    {d.media === 'cdrom' && <span className="gd-chip">CD/DVD</span>}
                    {!d.storage && d.key.startsWith('mp') && <span className="gd-chip">Bind mount</span>}
                  </span>
                  <span className="ui-row-subtitle t-mono gd-break">{d.volume}</span>
                </span>
                <span className="ui-row-value">{d.sizeBytes !== undefined ? formatBytes(d.sizeBytes) : (d.size ?? '')}</span>
              </div>
            ))}
          </ListGroup>
        )}
      </Card>

      <Card
        title="Network"
        subtitle={c.nets.length ? plural(c.nets.length, 'interface') : undefined}
        padding="none"
        className="gd-list"
        icon={<Cable size={16} strokeWidth={2.2} />}
        iconColor="var(--teal)"
      >
        {c.nets.length === 0 ? (
          <p className="gd-empty-note">No network interfaces in the configuration.</p>
        ) : (
          <ListGroup plain ariaLabel="Network interfaces">
            {c.nets.map((n) => (
              <div key={n.key} className="ui-row" role="listitem" data-wrap>
                <span className="ui-row-text">
                  <span className="ui-row-title gd-hw-title">
                    <span className="gd-key">{n.key}</span>
                    <span>{[n.name, n.model].filter(Boolean).join(' · ')}</span>
                    {n.linkDown && <StatusBadge tone="off" size="small" label="Link down" />}
                  </span>
                  <span className="ui-row-subtitle">
                    {[
                      n.mac ? (
                        <span key="mac" className="t-mono">
                          {n.mac}
                        </span>
                      ) : null,
                      n.bridge ? <span key="br">{n.bridge}</span> : null,
                      n.vlan !== undefined ? <span key="vlan">VLAN {n.vlan}</span> : null,
                      n.firewall ? <span key="fw">Firewall</span> : null,
                      n.rate !== undefined ? <span key="rate">{n.rate} MB/s limit</span> : null,
                    ]
                      .filter(Boolean)
                      .flatMap((el, i) => (i === 0 ? [el] : [<span key={`s${i}`}> · </span>, el]))}
                  </span>
                </span>
                {(n.ip || n.ip6) && (
                  <span className="ui-row-value gd-hw-ip">
                    {n.ip && (
                      <span className={n.ip.includes('/') || n.ip.includes('.') ? 't-mono' : undefined}>{n.ip === 'dhcp' ? 'DHCP' : n.ip}</span>
                    )}
                    {n.ip6 && n.ip6 !== 'manual' && (
                      <span className="t-mono t-label-2">{n.ip6 === 'auto' ? 'SLAAC' : n.ip6 === 'dhcp' ? 'DHCPv6' : n.ip6}</span>
                    )}
                  </span>
                )}
              </div>
            ))}
          </ListGroup>
        )}
      </Card>
    </div>
  );
}
