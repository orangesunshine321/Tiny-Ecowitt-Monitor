/** Building blocks of the Backups page: summary, coverage table, job cards, recent backup tasks and archive groups. */
import { CalendarClock, ChevronRight, KeyRound, Lock } from 'lucide-react';
import { useMemo } from 'react';
import type { BackupCoverage, BackupItem, BackupJob, Guest, TaskEntry } from '../../../../shared/types';
import {
  Card,
  ListGroup,
  ListRow,
  OsIcon,
  RelativeTime,
  RingGauge,
  StatusBadge,
  Table,
  TONE_COLOR,
  toneOf,
  type TableColumn,
} from '../../components';
import { formatBytes, formatDateTime, formatDays, formatFullDateTime, plural } from '../../format';
import { Facts, Pill, Stat, StatRow, TwoLine } from '../storage/ui';
import { TaskGlyph } from '../tasks/taskIcons';
import { describeTask, formatTaskDuration, taskDurationMs } from '../tasks/taskModel';
import {
  ageDays,
  coverageBadges,
  coverageTone,
  formatLabel,
  modeLabel,
  verificationStatus,
  type CoverageSummary,
  type GuestBackups,
} from './backupsModel';
import { describeSchedule } from './schedule';

type GuestLookup = (vmid: number) => Guest | undefined;
const typeNoun = (t: string | undefined) => (t === 'lxc' ? 'CT' : t === 'qemu' ? 'VM' : 'Guest');

// ───────────────────────────────────────────────────────────── summary

export interface SummaryProps {
  summary: CoverageSummary;
  staleDays: number;
  next?: { job: BackupJob; time: number };
  newest?: BackupItem;
  archives: number;
  totalSize?: number;
  storages: number;
  source?: 'ssh' | 'prunebackups';
}

export function SummaryCard({ summary, staleDays, next, newest, archives, totalSize, storages, source }: SummaryProps) {
  const tone = summary.total ? coverageTone(summary) : 'off';
  const fraction = summary.total ? summary.covered / summary.total : null;
  return (
    <Card className="bk-summary" span="full">
      <div className="bk-summary-main">
        <RingGauge
          value={fraction}
          size={96}
          color={TONE_COLOR[tone]}
          centerValue={summary.total ? `${summary.covered}/${summary.total}` : '–'}
          ariaLabel="Guests with a recent backup"
        />
        <div className="bk-summary-text">
          {summary.total ? (
            <>
              <div className="bk-hero">
                {summary.covered} of {plural(summary.total, 'guest')}
              </div>
              <div className="bk-hero-sub">backed up in the last {plural(staleDays, 'day')}</div>
            </>
          ) : (
            <>
              <div className="bk-hero">No coverage yet</div>
              <div className="bk-hero-sub">Coverage appears once the backup collector has run</div>
            </>
          )}
          {(summary.never > 0 || summary.stale > 0 || summary.notInAnyJob > 0) && (
            <div className="inf-pills bk-summary-pills">
              {summary.never > 0 && <StatusBadge tone="crit" label={`${summary.never} never backed up`} size="small" />}
              {summary.stale > 0 && <StatusBadge tone="warn" label={`${summary.stale} stale`} size="small" />}
              {summary.notInAnyJob > 0 && <StatusBadge tone="warn" label={`${summary.notInAnyJob} not in any job`} size="small" />}
            </div>
          )}
        </div>
      </div>
      <StatRow className="bk-summary-stats">
        <Stat
          label="Next run"
          value={next ? <RelativeTime time={next.time} format="short" /> : 'None'}
          caption={next ? `${next.job.comment || next.job.id} · ${formatDateTime(next.time)}` : 'No enabled job is scheduled'}
          title={next ? formatFullDateTime(next.time) : undefined}
        />
        <Stat
          label="Latest backup"
          value={newest ? <RelativeTime time={newest.ctime} format="short" /> : 'None'}
          caption={newest ? `${typeNoun(newest.guestType)} ${newest.vmid} · ${newest.storage}` : undefined}
        />
        <Stat
          label="Archives"
          value={archives.toLocaleString()}
          caption={totalSize !== undefined ? `${formatBytes(totalSize)} on ${plural(storages, 'storage')}` : plural(storages, 'storage')}
        />
        <Stat
          label="Source"
          value={source === 'prunebackups' ? 'API' : source === 'ssh' ? 'Host helper' : '–'}
          caption={source === 'prunebackups' ? 'Read-only listing' : source === 'ssh' ? 'Full listing over SSH' : 'Not collected yet'}
        />
      </StatRow>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── coverage

export function CoverageTable({ rows, lookup, now }: { rows: readonly BackupCoverage[]; lookup: GuestLookup; now: number }) {
  const columns = useMemo<TableColumn<BackupCoverage>[]>(
    () => [
      {
        key: 'guest',
        header: 'Guest',
        sortValue: (c) => c.name,
        cell: (c) => {
          const g = lookup(c.vmid);
          return (
            <span className="inf-cell">
              <OsIcon os={g?.osName} ostype={g?.config?.ostype} type={c.type} size={28} />
              <TwoLine
                title={c.name}
                subtitle={
                  <>
                    {typeNoun(c.type)} {c.vmid}
                    <span className="inf-only-iphone">
                      {' · '}
                      {c.lastBackup ? <RelativeTime time={c.lastBackup} /> : 'never'}
                    </span>
                  </>
                }
              />
            </span>
          );
        },
      },
      {
        key: 'last',
        header: 'Last backup',
        hideBelow: 'iphone',
        sortValue: (c) => c.lastBackup ?? 0,
        defaultDir: 'desc',
        cell: (c) =>
          c.lastBackup ? (
            <span title={formatFullDateTime(c.lastBackup)}>
              {formatDateTime(c.lastBackup)}
              <span className="t-label-2"> · {formatDays(ageDays(c, now))}</span>
            </span>
          ) : (
            <span className="inf-muted">Never</span>
          ),
      },
      { key: 'storage', header: 'Storage', hideBelow: 'ipad', sortValue: (c) => c.lastBackupStorage, cell: (c) => c.lastBackupStorage ?? <span className="inf-muted">–</span> },
      {
        key: 'status',
        header: 'Status',
        align: 'right',
        sortValue: (c) => (c.lastBackup === undefined ? 3 : c.stale ? 2 : 0) + (c.notInAnyJob ? 1 : 0),
        defaultDir: 'desc',
        cell: (c) => (
          <span className="bk-badges">
            {coverageBadges(c).map((b) => (
              <StatusBadge key={b.label} {...b} size="small" />
            ))}
          </span>
        ),
      },
    ],
    [lookup, now],
  );
  return <Table caption="Backup coverage per guest" columns={columns} rows={rows} rowKey={(c) => c.vmid} rowHref={(c) => (lookup(c.vmid) ? `/guests/${c.vmid}` : undefined)} />;
}

// ───────────────────────────────────────────────────────────── jobs

export function JobCard({ job }: { job: BackupJob }) {
  const human = describeSchedule(job.schedule);
  return (
    <Card
      className="bk-job inf-card-tight"
      title={job.comment || job.id}
      subtitle={job.comment ? <span className="inf-mono">{job.id}</span> : undefined}
      icon={<CalendarClock size={16} strokeWidth={2.2} />}
      iconColor="var(--gray)"
      accessory={<StatusBadge {...(job.enabled ? { tone: 'ok' as const, label: 'Enabled' } : { tone: 'off' as const, label: 'Disabled' })} size="small" />}
    >
      <div className="bk-job-schedule">
        <div className="bk-job-when">{human ?? (job.schedule ? 'Custom schedule' : 'No schedule')}</div>
        {job.schedule && (
          <Pill mono title="Proxmox calendar event (node local time)">
            {job.schedule}
          </Pill>
        )}
      </div>
      <Facts
        items={[
          {
            label: 'Next run',
            value:
              typeof job.nextRun === 'number' ? (
                <span title={formatFullDateTime(job.nextRun)}>
                  {formatDateTime(job.nextRun)}
                  <span className="t-label-2">
                    {' · '}
                    <RelativeTime time={job.nextRun} />
                  </span>
                </span>
              ) : (
                '–'
              ),
          },
          { label: 'Guests', value: job.selection || '–' },
          { label: 'Storage', value: job.storage ?? '–' },
          { label: 'Mode', value: modeLabel(job.mode) },
        ]}
      />
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── recent tasks

export function RecentBackupTasks({ tasks, lookup, now, onOpen }: { tasks: readonly TaskEntry[]; lookup: GuestLookup; now: number; onOpen: (t: TaskEntry) => void }) {
  return (
    <ListGroup plain ariaLabel="Recent backup tasks">
      {tasks.map((t) => {
        const d = describeTask(t, lookup);
        const when = formatDateTime(t.startTime);
        const dur = formatTaskDuration(taskDurationMs(t, now));
        return (
          <ListRow
            key={t.upid}
            icon={<TaskGlyph kind="backup" size={30} />}
            title={d.detail && d.vmid !== undefined ? `${d.title} · ${d.detail}` : d.title}
            subtitle={`${when} · ${t.severity === 'running' ? `running for ${dur}` : dur}${t.severity === 'error' && t.status ? ` · ${t.status}` : ''}`}
            value={<StatusBadge {...toneOf.task(t.severity)} size="small" spinning={t.severity === 'running'} />}
            onClick={() => onOpen(t)}
          />
        );
      })}
    </ListGroup>
  );
}

// ───────────────────────────────────────────────────────────── archives

/**
 * Archive table columns. Columns without information for this guest are dropped (no verification outside PBS, no
 * flags), and notes equal to the guest name (the default "{{guestname}}" notes template) are not repeated.
 */
function archiveColumns(items: readonly BackupItem[], guestName: string): TableColumn<BackupItem>[] {
  const note = (i: BackupItem) => (i.notes && i.notes.trim() !== guestName ? i.notes : undefined);
  const hasNotes = items.some(note);
  const hasVerify = items.some((i) => i.verification);
  const hasFlags = items.some((i) => i.protected || i.encrypted);
  return ARCHIVE_COLUMNS(note).filter(
    (c) => (c.key !== 'notes' || hasNotes) && (c.key !== 'verify' || hasVerify) && (c.key !== 'flags' || hasFlags),
  );
}

const ARCHIVE_COLUMNS = (note: (i: BackupItem) => string | undefined): TableColumn<BackupItem>[] => [
  {
    key: 'created',
    header: 'Created',
    sortValue: (i) => i.ctime,
    defaultDir: 'desc',
    cell: (i) => (
      <span title={`${formatFullDateTime(i.ctime)}\n${i.volid}`}>
        {formatDateTime(i.ctime)}
        {note(i) && <span className="inf-only-iphone bk-note-inline">{note(i)}</span>}
      </span>
    ),
  },
  { key: 'storage', header: 'Storage', sortValue: (i) => i.storage, cell: (i) => i.storage },
  {
    key: 'size',
    header: 'Size',
    align: 'right',
    sortValue: (i) => i.size,
    cell: (i) => (typeof i.size === 'number' ? formatBytes(i.size) : <span className="inf-muted">–</span>),
  },
  {
    key: 'format',
    header: 'Format',
    hideBelow: 'iphone',
    sortValue: (i) => i.format,
    cell: (i) => (i.format ? <span title={i.format}>{formatLabel(i.format)}</span> : <span className="inf-muted">–</span>),
  },
  {
    key: 'verify',
    header: 'Verified',
    hideBelow: 'iphone',
    sortValue: (i) => i.verification,
    cell: (i) => {
      const v = verificationStatus(i.verification);
      return v ? <StatusBadge {...v} size="small" /> : <span className="inf-muted">–</span>;
    },
  },
  {
    key: 'notes',
    header: 'Notes',
    hideBelow: 'ipad',
    truncate: 220,
    sortValue: (i) => note(i),
    cell: (i) => (note(i) ? <span title={note(i)}>{note(i)}</span> : <span className="inf-muted">–</span>),
  },
  {
    key: 'flags',
    header: <span className="sr-only">Protection</span>,
    align: 'right',
    cell: (i) => (
      <span className="bk-flags">
        {i.protected && (
          <span className="bk-flag" title="Protected: Proxmox won't prune or remove this backup">
            <Lock size={13} strokeWidth={2.4} aria-hidden="true" />
            <span className="inf-hide-iphone">Protected</span>
            <span className="sr-only inf-only-iphone">Protected</span>
          </span>
        )}
        {i.encrypted && (
          <span className="bk-flag" title="Encrypted on the backup server">
            <KeyRound size={13} strokeWidth={2.4} aria-hidden="true" />
            <span className="inf-hide-iphone">Encrypted</span>
            <span className="sr-only inf-only-iphone">Encrypted</span>
          </span>
        )}
      </span>
    ),
  },
];

export function ArchiveGroup({ group, guest, open, onToggle }: { group: GuestBackups; guest?: Guest; open: boolean; onToggle: () => void }) {
  const name = guest?.name ?? group.items.find((i) => i.notes)?.notes ?? `${typeNoun(group.type)} ${group.vmid}`;
  const type = guest?.type ?? group.type;
  const bodyId = `bk-group-${group.vmid}`;
  const columns = useMemo(() => archiveColumns(group.items, name), [group.items, name]);
  return (
    <div className="bk-group" data-open={open || undefined} id={`guest-${group.vmid}`}>
      <button type="button" className="bk-group-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <ChevronRight className="bk-chevron" size={16} strokeWidth={2.6} aria-hidden="true" />
        <OsIcon os={guest?.osName} ostype={guest?.config?.ostype} type={type} size={30} />
        <TwoLine
          title={name}
          subtitle={[
            `${typeNoun(type)} ${group.vmid}`,
            guest ? undefined : 'not on this node',
            plural(group.items.length, 'backup'),
            group.totalSize !== undefined ? formatBytes(group.totalSize) : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
        <span className="bk-group-latest">
          <span className="inf-hide-iphone">Latest </span>
          <RelativeTime time={group.newest} />
        </span>
      </button>
      {open && (
        <div className="bk-group-body" id={bodyId}>
          <Table caption={`Backups of ${name}`} columns={columns} rows={group.items} rowKey={(i) => i.volid} dense />
        </div>
      )}
    </div>
  );
}
