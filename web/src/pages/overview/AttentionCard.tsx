import {
  Archive,
  ArchiveX,
  Bell,
  CircleArrowDown,
  CircleCheckBig,
  CloudOff,
  Container,
  Database,
  HardDrive,
  ListX,
  MonitorOff,
  ServerCrash,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import type { AlertSeverity, Snapshot } from '../../../../shared/types';
import { Button, Card, EmptyState, ListGroup, ListRow, RelativeTime, TONE_COLOR, type Tone } from '../../components';
import { useServerNow } from '../../hooks';
import { useSnapshot } from '../../store';
import { attentionSummary, deriveAttention, type AttentionInput, type AttentionKind } from './attention';

const ICON: Record<AttentionKind, LucideIcon> = {
  node_unreachable: ServerCrash,
  guest_stopped: MonitorOff,
  service_down: CloudOff,
  container_unhealthy: Container,
  backup_failed: ArchiveX,
  backup_stale: Archive,
  storage_usage: Database,
  disk_health: HardDrive,
  zfs_degraded: Database,
  updates_available: CircleArrowDown,
  test: Bell,
  task_failed: ListX,
};

const SEVERITY: Record<AlertSeverity, { tone: Tone; label: string }> = {
  critical: { tone: 'crit', label: 'Critical' },
  warning: { tone: 'warn', label: 'Warning' },
  info: { tone: 'info', label: 'Info' },
};

/** Items shown before "Show more". */
const LIMIT = 6;

const select = (s: Snapshot): AttentionInput => ({
  node: s.node,
  alerts: s.alerts,
  zfs: s.zfs,
  disks: s.disks,
  services: s.services,
  guests: s.guests,
  inventory: s.inventory,
  backups: s.backups,
  tasks: s.tasks,
  storage: s.storage,
  meta: s.meta,
});

/** Everything that needs a look, worst first; each row opens the page that explains it. */
export function AttentionCard({ style }: { style?: CSSProperties }) {
  const input = useSnapshot(select);
  const now = useServerNow(60_000);
  const items = useMemo(() => deriveAttention(input, now), [input, now]);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, LIMIT);
  const hidden = items.length - shown.length;

  return (
    <Card
      title="Attention"
      subtitle={attentionSummary(items)}
      padding="none"
      className="ov-list"
      style={style}
      accessory={
        <Button variant="plain" size="small" href="/alerts">
          Alerts
        </Button>
      }
    >
      {items.length === 0 ? (
        <div className="ov-pad">
          <EmptyState
            compact
            tone="ok"
            icon={<CircleCheckBig size={24} strokeWidth={2} />}
            title="All systems nominal"
            message="No alerts, and nothing in storage, backups, services or tasks needs your attention."
          />
        </div>
      ) : (
        <>
          <ListGroup plain ariaLabel="Needs attention">
            {shown.map((item) => {
              const Icon = ICON[item.kind] ?? Bell;
              const sev = SEVERITY[item.severity];
              return (
                <ListRow
                  key={item.key}
                  icon={<Icon strokeWidth={2.1} />}
                  iconColor={TONE_COLOR[sev.tone]}
                  title={item.title}
                  subtitle={
                    <>
                      <span className="ov-sev" data-tone={sev.tone}>
                        {sev.label}
                      </span>
                      {item.detail ? ` · ${item.detail}` : ''}
                    </>
                  }
                  value={item.time !== undefined ? <RelativeTime time={item.time} className="ov-when" /> : undefined}
                  href={item.path}
                />
              );
            })}
          </ListGroup>
          {(hidden > 0 || expanded) && items.length > LIMIT && (
            <button type="button" className="ov-more" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Show fewer' : `Show ${hidden} more`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}
