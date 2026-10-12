/**
 * Task log inspector: a Sheet with the task summary and its log (GET /api/tasks/:upid/log, monospace).
 * While the task is RUNNING the log is polled every 2 s and follows the end; when the snapshot reports it finished,
 * one last fetch picks up the final "TASK OK / WARNINGS / ERROR" line.
 */
import { ArrowDownToLine, Copy } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TaskEntry } from '../../../../shared/types';
import { getTaskLog } from '../../api';
import { Button, EmptyState, IconButton, ListGroup, ListRow, Meter, Sheet, Skeleton, StatusBadge, StatusDot, toneOf } from '../../components';
import { formatDateTime, formatFullDateTime, formatNumber, formatPercent } from '../../format';
import { useAsync } from '../../hooks/useAsync';
import { prefersReducedMotion } from '../../hooks/useMediaQuery';
import { useServerNow } from '../../hooks/useNow';
import { Link } from '../../router';
import { pushToast, useSnapshot } from '../../store';
import { Facts, Pill } from '../storage/ui';
import {
  describeTask,
  firstLineNumber,
  formatTaskDuration,
  logLineTone,
  parseVzdumpLog,
  splitUser,
  taskDurationMs,
  taskProgress,
} from './taskModel';
import './tasks.css';

/** Lines requested from the server (it returns the tail of longer logs). */
const LOG_LIMIT = 1000;
const POLL_MS = 2000;

export interface TaskLogSheetProps {
  /** the task to show; null closes the sheet */
  task: TaskEntry | null;
  onClose: () => void;
}

export function TaskLogSheet({ task, onClose }: TaskLogSheetProps) {
  // keep the last task while the sheet animates out
  const [shown, setShown] = useState<TaskEntry | null>(task);
  useEffect(() => {
    if (task) setShown(task);
  }, [task]);
  const open = task !== null;
  return (
    <Sheet open={open} onClose={onClose} size="large" title={shown ? <TaskTitle task={shown} /> : 'Task'} subtitle={shown ? <TaskSubtitle task={shown} /> : undefined}>
      {shown && <TaskLogBody key={shown.upid} task={shown} open={open} />}
    </Sheet>
  );
}

/** "00:01:42" → ms */
function hmsToMs(hms: string): number | undefined {
  const parts = hms.split(':').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return ((parts[0]! * 60 + parts[1]!) * 60 + parts[2]!) * 1000;
}

function useLiveTask(task: TaskEntry): TaskEntry {
  // the snapshot keeps the task list fresh (status, end time); fall back to what we were given once it rotates out
  const upid = task.upid;
  const live = useSnapshot(useCallback((s) => s.tasks.find((t) => t.upid === upid), [upid]), Object.is);
  return live ?? task;
}

function useGuestLookup() {
  const guests = useSnapshot((s) => s.guests, Object.is);
  return useMemo(() => {
    const byId = new Map(guests.map((g) => [g.vmid, g]));
    return (vmid: number) => byId.get(vmid);
  }, [guests]);
}

function TaskTitle({ task }: { task: TaskEntry }) {
  const lookup = useGuestLookup();
  const live = useLiveTask(task);
  return <>{describeTask(live, lookup).title}</>;
}

function TaskSubtitle({ task }: { task: TaskEntry }) {
  const lookup = useGuestLookup();
  const live = useLiveTask(task);
  const d = describeTask(live, lookup);
  return (
    <span className="tlog-subtitle">
      <StatusBadge {...toneOf.task(live.severity)} size="small" spinning={live.severity === 'running'} />
      <span>{[d.detail, formatDateTime(live.startTime)].filter(Boolean).join(' · ')}</span>
    </span>
  );
}

function TaskLogBody({ task, open }: { task: TaskEntry; open: boolean }) {
  const live = useLiveTask(task);
  const lookup = useGuestLookup();
  const running = live.severity === 'running';
  const now = useServerNow(running ? 1000 : 30_000);
  const d = describeTask(live, lookup);
  const { user, token } = splitUser(live.user);

  const log = useAsync((signal) => getTaskLog(live.upid, { signal, limit: LOG_LIMIT }), [live.upid, live.severity], {
    enabled: open,
    refreshMs: running ? POLL_MS : undefined,
  });
  const data = log.data?.upid === live.upid ? log.data : undefined;

  // ── follow the end of the log while running
  const rootRef = useRef<HTMLDivElement>(null);
  const stick = useRef(running);
  const scroller = () => rootRef.current?.closest<HTMLElement>('.ui-sheet-body') ?? null;
  useEffect(() => {
    const el = scroller();
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    if (!data || !stick.current) return;
    const el = scroller();
    if (el) el.scrollTop = el.scrollHeight;
  }, [data]);
  const jumpToEnd = () => {
    const el = scroller();
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    stick.current = true;
  };

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.lines.join('\n'));
      pushToast({ tone: 'ok', title: 'Log copied', duration: 2500, key: 'task-log-copy' });
    } catch {
      pushToast({ tone: 'warn', title: 'Could not copy the log', body: 'The browser blocked clipboard access.', key: 'task-log-copy' });
    }
  };

  const errorText = live.severity === 'error' || live.severity === 'warning' ? live.status : undefined;
  const first = data ? firstLineNumber(data.total, data.lines.length) : 1;
  const guestResults = useMemo(() => (live.type === 'vzdump' && data ? parseVzdumpLog(data.lines) : []), [live.type, data]);
  const progress = useMemo(() => (running && data ? taskProgress(data.lines) : undefined), [running, data]);

  return (
    <div className="tlog-body" ref={rootRef}>
      <div className="tlog-summary material-card">
        {running && progress !== undefined && (
          <div className="tlog-progress">
            <Meter value={progress} label="Progress" valueLabel={formatPercent(progress)} tone="info" />
          </div>
        )}
        <Facts
          items={[
            errorText ? { label: live.severity === 'error' ? 'Error' : 'Result', value: <span className="tlog-result" data-tone={live.severity}>{errorText}</span>, wrap: true } : null,
            { label: 'Started', value: <span title={formatFullDateTime(live.startTime)}>{formatDateTime(live.startTime)}</span> },
            live.endTime ? { label: 'Ended', value: <span title={formatFullDateTime(live.endTime)}>{formatDateTime(live.endTime)}</span> } : null,
            { label: running ? 'Running for' : 'Duration', value: <span className="t-num">{formatTaskDuration(taskDurationMs(live, now))}</span> },
            {
              label: 'User',
              value: (
                <>
                  <span>{user}</span>
                  {token && (
                    <Pill mono title="API token">
                      !{token}
                    </Pill>
                  )}
                </>
              ),
            },
            d.vmid !== undefined && lookup(d.vmid) ? { label: 'Guest', value: <Link to={`/guests/${d.vmid}`}>{lookup(d.vmid)!.name}</Link> } : null,
            { label: 'Type', value: live.type, mono: true },
            { label: 'UPID', value: live.upid, mono: true, wrap: true },
          ]}
        />
      </div>

      {guestResults.length > 0 && (
        <ListGroup
          header="Guests"
          footer={data && data.total > data.lines.length ? 'From the visible part of the log; earlier guests may be missing.' : undefined}
        >
          {guestResults.map((r) => {
            const g = lookup(r.vmid);
            const type = g?.type ?? r.type;
            const label = `${type === 'lxc' ? 'CT' : type === 'qemu' ? 'VM' : 'Guest'} ${r.vmid}`;
            const tone = r.status === 'ok' ? toneOf.task('ok') : r.status === 'failed' ? toneOf.task('error') : toneOf.task('running');
            return (
              <ListRow
                key={r.vmid}
                dense
                wrap={!!r.error}
                href={g ? `/guests/${r.vmid}` : undefined}
                title={g?.name ?? label}
                subtitle={[g ? label : undefined, r.duration ? formatTaskDuration(hmsToMs(r.duration)) : undefined, r.error].filter(Boolean).join(' · ')}
                value={<StatusBadge {...tone} size="small" spinning={r.status === 'running'} />}
              />
            );
          })}
        </ListGroup>
      )}

      <div className="tlog-loghead">
        <div className="tlog-loghead-titles">
          <h3 className="t-headline">Log</h3>
          <span className="t-footnote t-label-2">
            {data
              ? data.total > data.lines.length
                ? `Last ${formatNumber(data.lines.length)} of ${formatNumber(data.total)} lines`
                : `${formatNumber(data.total)} ${data.total === 1 ? 'line' : 'lines'}`
              : log.loading
                ? 'Loading…'
                : ''}
          </span>
          {running && (
            <span className="tlog-live t-footnote">
              <StatusDot tone="info" pulse size={7} /> Updating every 2 s
            </span>
          )}
        </div>
        <div className="tlog-loghead-actions">
          <IconButton icon={<ArrowDownToLine size={16} strokeWidth={2.2} />} label="Jump to the end" size="small" variant="gray" onClick={jumpToEnd} disabled={!data} />
          <IconButton icon={<Copy size={15} strokeWidth={2.2} />} label="Copy log" size="small" variant="gray" onClick={copy} disabled={!data} />
        </div>
      </div>

      {data ? (
        <div className="tlog" role="log" aria-label={`Log of ${d.title}`} aria-live={running ? 'polite' : 'off'}>
          {data.lines.map((line, i) => (
            <div key={first + i} className="tlog-line" data-tone={logLineTone(line)}>
              <span className="tlog-n" aria-hidden="true">
                {first + i}
              </span>
              <span className="tlog-t">{line || ' '}</span>
            </div>
          ))}
        </div>
      ) : log.error ? (
        <EmptyState
          compact
          tone="warn"
          title="Could not load the log"
          message={log.error}
          action={
            <Button size="small" onClick={log.reload}>
              Try again
            </Button>
          }
        />
      ) : (
        <div className="tlog tlog-skeleton" aria-busy="true">
          <Skeleton lines={8} height={12} />
        </div>
      )}
      {data && log.error && <p className="tlog-stale t-footnote">Updates paused: {log.error}</p>}
    </div>
  );
}
