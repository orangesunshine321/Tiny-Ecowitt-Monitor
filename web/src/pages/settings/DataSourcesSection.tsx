/**
 * Settings → Data sources: Proxmox API and collector freshness (meta.collectors), the apps & services inventory
 * status, and how to add a VM without the QEMU guest agent (copyable setup command + config.yaml snippet).
 */
import { Boxes, CircleAlert, Cpu, KeyRound, Server, Thermometer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { guestSetupCommand } from '../../api';
import { ListGroup, ListRow, RelativeTime, StatusBadge, StatusDot } from '../../components';
import { formatDuration, plural } from '../../format';
import { useServerNow } from '../../hooks/useNow';
import { collectorLabel, collectorTone } from '../../shell/LiveIndicator';
import { useSnapshot } from '../../store';
import { INVENTORY_SOURCE_LABEL, agentlessCandidates, guestYamlSnippet, inventoryStatus } from './settingsModel';
import { Callout, CodeBlock, ListItem, SelectField } from './ui';

const TONE_WORD = { ok: 'fresh', warn: 'stale', crit: 'failing', off: 'waiting', info: 'running' } as const;

export function DataSourcesSection() {
  const meta = useSnapshot((s) => s.meta, Object.is);
  const node = useSnapshot((s) => ({ online: s.node.online, error: s.node.error, name: s.node.node, lastUpdated: s.node.lastUpdated }));
  const guests = useSnapshot((s) => s.guests, Object.is);
  const inventory = useSnapshot((s) => s.inventory, Object.is);
  const host = useSnapshot((s) => s.hostInventory, Object.is);
  const now = useServerNow(10_000);

  const collectors = useMemo(
    () => [...meta.collectors].sort((a, b) => collectorLabel(a.name).localeCompare(collectorLabel(b.name))),
    [meta.collectors],
  );
  const inv = useMemo(() => inventoryStatus(guests, inventory), [guests, inventory]);
  const failingCollectors = collectors.filter((c) => collectorTone(c, now) === 'crit').length;

  return (
    <div className="set-stack">
      <ListGroup header="Data sources">
        <ListRow
          icon={<Server strokeWidth={2} />}
          title="Proxmox VE API"
          subtitle={node.online ? `${node.name} · read-only token` : (node.error ?? 'Not reachable')}
          wrap={!node.online}
          value={<StatusBadge size="small" tone={node.online ? 'ok' : 'crit'} label={node.online ? 'Online' : 'Offline'} />}
        />
        <ListRow
          icon={<Boxes strokeWidth={2} />}
          title="Apps & services inventory"
          subtitle={
            meta.inventoryEnabled
              ? [plural(inv.ok, 'guest') + ' collected', inv.failing.length ? `${inv.failing.length} failing` : ''].filter(Boolean).join(' · ')
              : 'Off: set inventory.enabled in config.yaml'
          }
          value={
            <StatusBadge
              size="small"
              tone={!meta.inventoryEnabled ? 'off' : inv.failing.length ? 'warn' : 'ok'}
              label={meta.inventoryEnabled ? (inv.failing.length ? 'Partial' : 'On') : 'Off'}
            />
          }
        />
        {meta.inventoryEnabled && (
          <ListRow
            icon={<KeyRound strokeWidth={2} />}
            title="Host helper (SSH)"
            subtitle={
              host ? (
                host.ok ? (
                  <>
                    Last run <RelativeTime time={host.collectedAt} />
                  </>
                ) : (
                  (host.error ?? 'Failed')
                )
              ) : (
                'Waiting for the first run'
              )
            }
            wrap={!!host && !host.ok}
            value={<StatusBadge size="small" tone={!host ? 'off' : host.ok ? 'ok' : 'crit'} label={!host ? 'Waiting' : host.ok ? 'OK' : 'Failing'} />}
          />
        )}
        {meta.inventoryEnabled && host?.ok && (
          <ListRow
            icon={<Thermometer strokeWidth={2} />}
            title="Temperature sensors"
            subtitle={host.sensorsAvailable ? plural(host.temps.length, 'sensor') : 'lm-sensors not installed on the host'}
            value={<StatusBadge size="small" tone={host.sensorsAvailable ? 'ok' : 'off'} label={host.sensorsAvailable ? 'Available' : 'None'} />}
          />
        )}
      </ListGroup>

      {meta.inventoryEnabled && (inv.failing.length > 0 || inv.missing.length > 0) && (
        <ListGroup header="Inventory problems" footer="Containers are read with pct exec, VMs with the guest agent, and agentless VMs over SSH.">
          {inv.failing.map((f) => (
            <ListRow
              key={f.vmid}
              wrap
              icon={<CircleAlert strokeWidth={2} />}
              iconColor="var(--status-warn)"
              title={`${f.name} (${f.vmid})`}
              subtitle={f.error}
              value={INVENTORY_SOURCE_LABEL[f.source]}
              href={`/guests/${f.vmid}?tab=apps`}
            />
          ))}
          {inv.missing.length > 0 && (
            <ListRow
              wrap
              icon={<Cpu strokeWidth={2} />}
              title="Not collected yet"
              subtitle={inv.missing.map((m) => `${m.name} (${m.vmid})`).join(', ')}
            />
          )}
        </ListGroup>
      )}

      <ListGroup
        header="Collector freshness"
        footer={
          failingCollectors
            ? `${plural(failingCollectors, 'collector')} failing. The dashboard keeps the last good data.`
            : 'How recently each part of the data was refreshed.'
        }
      >
        {collectors.length === 0 && <ListRow title={<span className="t-label-2">No collector has reported yet</span>} />}
        {collectors.map((c) => {
          const tone = collectorTone(c, now);
          return (
            <ListRow
              key={c.name}
              dense
              wrap={tone === 'crit'}
              icon={<StatusDot tone={tone} size={9} label={TONE_WORD[tone]} />}
              title={
                <>
                  {collectorLabel(c.name)} <span className="set-every">every {formatDuration(c.intervalSec, { units: 1 })}</span>
                </>
              }
              subtitle={tone === 'crit' && c.lastError ? <span className="set-device-error">{c.lastError}</span> : undefined}
              value={c.lastSuccess ? <RelativeTime time={c.lastSuccess} /> : 'never'}
            />
          );
        })}
      </ListGroup>
    </div>
  );
}

/** "Add a VM without guest agent": setup command, config snippet (prefilled for a VM that needs it), restart. */
export function AddVmSection() {
  const publicUrl = useSnapshot((s) => s.meta.publicUrl);
  const guests = useSnapshot((s) => s.guests, Object.is);
  const inventory = useSnapshot((s) => s.inventory, Object.is);
  const candidates = useMemo(() => agentlessCandidates(guests, inventory), [guests, inventory]);
  const [picked, setPicked] = useState<string>('');
  const chosen = candidates.find((c) => String(c.vmid) === picked) ?? candidates[0];
  const command = guestSetupCommand(publicUrl);
  const yaml = guestYamlSnippet(chosen ? { vmid: chosen.vmid, address: chosen.address } : {});

  return (
    <section id="add-vm" className="set-anchor" aria-label="Add a VM without guest agent">
      <ListGroup
        header="Add a VM without guest agent"
        footer={
          <>
            Prefer the agent? Install <code>qemu-guest-agent</code> in the VM, tick Options → QEMU Guest Agent in Proxmox, then stop and start the VM.
          </>
        }
      >
        <ListItem className="set-steps">
          <p className="set-lead">
            Containers and VMs with the QEMU guest agent need no setup. For a VM without the agent, pve1-dash connects over SSH with a key that can
            only run a read-only inventory script.
          </p>
          <ol className="set-steplist">
            <li>
              <div className="set-step-title">Run this inside the VM as root</div>
              <CodeBlock label="setup command" text={command} />
              {!publicUrl && (
                <div className="set-step-note">
                  Uses the address you opened the dashboard with. Set <code>publicUrl</code> in config.yaml to show your HTTPS address here.
                </div>
              )}
            </li>
            <li>
              <div className="set-step-title set-step-title-row">
                <span>Add it to /etc/pve1-dash/config.yaml</span>
                {candidates.length > 1 && (
                  <SelectField
                    ariaLabel="VM to add"
                    value={chosen ? String(chosen.vmid) : ''}
                    options={candidates.map((c) => ({ value: String(c.vmid), label: `${c.name} (${c.vmid})` }))}
                    onChange={setPicked}
                  />
                )}
              </div>
              <CodeBlock label="config snippet" text={yaml} />
              <div className="set-step-note">
                {chosen
                  ? chosen.address
                    ? `Prefilled for ${chosen.name}. Check that the address is reachable from the dashboard.`
                    : `Prefilled for ${chosen.name}; replace the address with the VM’s IP.`
                  : 'Replace the vmid and address with your VM’s.'}{' '}
                The setup script prints the same snippet.
              </div>
            </li>
            <li>
              <div className="set-step-title">Restart the dashboard (inside its container)</div>
              <CodeBlock label="restart command" text="systemctl restart pve1-dash" />
            </li>
          </ol>
        </ListItem>
      </ListGroup>
      {candidates.length === 0 && guests.some((g) => g.type === 'qemu' && !g.template) && (
        <div className="set-after-note">
          <Callout tone="ok" icon={<Server size={16} strokeWidth={2} />} title="Every VM is covered">
            All VMs have the guest agent enabled or are already collected over SSH.
          </Callout>
        </div>
      )}
    </section>
  );
}
