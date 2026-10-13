import {
  Archive,
  ArchiveX,
  Bell,
  CircleArrowDown,
  CircleCheckBig,
  CloudOff,
  Container,
  Database,
  FileExclamationPoint,
  HardDrive,
  ListX,
  MonitorOff,
  ServerCog,
  ServerCrash,
  ShieldAlert,
  Thermometer,
  type LucideIcon,
} from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import type { AlertSeverity } from '../../../../shared/types';
import { Button, Card, EmptyState, ListGroup, ListRow, RelativeTime, TONE_COLOR, type Tone } from '../../components';
import { attentionSummary, snoozeText, type AttentionItem, type AttentionKind } from './attention';
import { useOverviewAttention } from './useAttention';

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
  guest_disk: HardDrive,
  cert_expiry: ShieldAlert,
  temperature: Thermometer,
  test: Bell,
  task_failed: ListX,
  host_service: ServerCog,
  config_error: FileExclamationPoint,
};

const SEVERITY: Record<AlertSeverity, { tone: Tone; label: string }> = {
  critical: { tone: 'crit', label: 'Critical' },
  warning: { tone: 'warn', label: 'Warning' },
  info: { tone: 'info', label: 'Info' },
};

function AttentionRow({ item }: { item: AttentionItem }) {
  const Icon = ICON[item.kind] ?? Bell;
  const sev = SEVERITY[item.severity];
  return (
    <ListRow
      className={item.snoozed ? 'ov-snoozed' : undefined}
      icon={<Icon strokeWidth={2.1} />}
      iconColor={item.snoozed ? 'var(--status-off)' : TONE_COLOR[sev.tone]}
      title={item.title}
      subtitle={
        item.snoozed ? (
          <>
            <span className="ov-sev" data-tone="off">
              {snoozeText(item)}
            </span>
            {` · ${sev.label}`}
          </>
        ) : (
          <>
            <span className="ov-sev" data-tone={sev.tone}>
              {sev.label}
            </span>
            {item.detail ? ` · ${item.detail}` : ''}
          </>
        )
      }
      value={item.time !== undefined ? <RelativeTime time={item.time} className="ov-when" /> : undefined}
      href={item.path}
    />
  );
}

export interface AttentionCardProps {
  style?: CSSProperties;
  /** items shown before "Show more" (default 6) */
  limit?: number;
  /** element id */
  id?: string;
  /** render nothing while there is nothing to list (iPhone, where the status strip covers "all nominal") */
  hideWhenEmpty?: boolean;
}

/** Everything that needs a look, worst first (snoozed alerts last, muted); each row opens the page that explains it. */
export function AttentionCard({ style, limit = 6, id, hideWhenEmpty }: AttentionCardProps) {
  const { items, nodeErrorShown } = useOverviewAttention();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, limit);
  const hidden = items.slice(shown.length);
  const hiddenSnoozedOnly = hidden.length > 0 && hidden.every((i) => i.snoozed);
  if (hideWhenEmpty && !items.length) return null;

  return (
    <Card
      title="Attention"
      subtitle={nodeErrorShown && !items.length ? 'Nothing else needs a look' : attentionSummary(items)}
      padding="none"
      className="ov-list"
      style={style}
      id={id}
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
            title={nodeErrorShown ? 'Nothing else needs a look' : 'All systems nominal'}
            message={
              nodeErrorShown
                ? 'Apart from the Proxmox connection above. Everything here is from the last values Proxmox sent.'
                : 'No alerts, and nothing in storage, backups, services or tasks needs your attention.'
            }
          />
        </div>
      ) : (
        <>
          <ListGroup plain ariaLabel="Needs attention">
            {shown.map((item) => (
              <AttentionRow key={item.key} item={item} />
            ))}
          </ListGroup>
          {(hidden.length > 0 || expanded) && items.length > limit && (
            <button type="button" className="ov-more" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Show fewer' : `Show ${hidden.length} ${hiddenSnoozedOnly ? 'snoozed' : 'more'}`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}
