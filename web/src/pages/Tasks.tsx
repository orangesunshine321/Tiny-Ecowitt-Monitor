/**
 * Tasks (DESIGN §5): recent Proxmox tasks with friendly labels, filters (All / Errors / Running + type) and a log
 * sheet that polls while the task runs. Filters and the open task live in the query string (?filter=errors&type=vzdump
 * &task=<UPID>), so other pages can deep-link here.
 */
import { CircleCheck, ListChecks, LoaderCircle } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import type { TaskEntry } from '../../../shared/types';
import { Card, EmptyState, PageHeader, RelativeTime, SegmentedControl, StatusBadge, Table, toneOf, type TableColumn } from '../components';
import { formatFullDateTime, plural } from '../format';
import { useServerNow } from '../hooks/useNow';
import { setQuery, useQueryParam } from '../router';
import { useSnapshot } from '../store';
import { FilterBar, Pill, SelectField, TwoLine } from './storage/ui';
import { TaskLogSheet } from './tasks/TaskLogSheet';
import { TaskGlyph } from './tasks/taskIcons';
import {
  countBySeverity,
  describeTask,
  filterTasks,
  formatTaskDuration,
  sortTasks,
  splitUser,
  taskDurationMs,
  taskTypeLabel,
  typeOptions,
  type TaskFilter,
} from './tasks/taskModel';
import './storage/ui.css';
import './tasks/tasks.css';

const FILTERS: { value: TaskFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'errors', label: 'Errors' },
  { value: 'running', label: 'Running' },
];

const SEVERITY_RANK: Record<TaskEntry['severity'], number> = { running: 3, error: 2, warning: 1, ok: 0 };

export default function TasksPage() {
  const tasks = useSnapshot((s) => s.tasks, Object.is);
  const guests = useSnapshot((s) => s.guests, Object.is);
  const filterParam = useQueryParam('filter');
  const filter: TaskFilter = filterParam === 'errors' || filterParam === 'running' ? filterParam : 'all';
  const type = useQueryParam('type') ?? '';
  const openUpid = useQueryParam('task');

  const lookup = useMemo(() => {
    const byId = new Map(guests.map((g) => [g.vmid, g]));
    return (vmid: number) => byId.get(vmid);
  }, [guests]);

  const sorted = useMemo(() => sortTasks(tasks), [tasks]);
  const counts = useMemo(() => countBySeverity(tasks), [tasks]);
  const rows = useMemo(() => filterTasks(sorted, filter, type), [sorted, filter, type]);
  const types = useMemo(() => {
    const opts = typeOptions(tasks).map((o) => ({ value: o.type, label: `${o.label} (${o.count})` }));
    // keep a deep-linked type selectable even when no such task is in the current list
    if (type && !opts.some((o) => o.value === type)) opts.push({ value: type, label: `${taskTypeLabel(type)} (0)` });
    return [{ value: '', label: 'All types' }, ...opts];
  }, [tasks, type]);

  // running durations tick every second; otherwise a slow clock is enough
  const now = useServerNow(counts.running > 0 ? 1000 : 30_000);

  const selected = useMemo(() => (openUpid ? (tasks.find((t) => t.upid === openUpid) ?? null) : null), [openUpid, tasks]);
  const openTask = useCallback((t: TaskEntry) => setQuery({ task: t.upid }), []);
  const closeTask = useCallback(() => setQuery({ task: null }), []);

  const columns = useMemo<TableColumn<TaskEntry>[]>(
    () => [
      {
        key: 'task',
        header: 'Task',
        sortValue: (t) => describeTask(t, lookup).title,
        cell: (t) => {
          const d = describeTask(t, lookup);
          return (
            <span className="tasks-taskcell">
              <TaskGlyph kind={d.kind} />
              <TwoLine
                title={d.title}
                subtitle={
                  <>
                    {d.detail}
                    <span className="inf-only-iphone">
                      {d.detail ? ' · ' : ''}
                      <RelativeTime time={t.startTime} />
                      {t.severity !== 'running' && ` · ${formatTaskDuration(taskDurationMs(t, now))}`}
                    </span>
                  </>
                }
              />
            </span>
          );
        },
      },
      {
        key: 'user',
        header: 'User',
        hideBelow: 'ipad',
        sortValue: (t) => t.user,
        cell: (t) => {
          const { user, token } = splitUser(t.user);
          return (
            <span className="tasks-user">
              {user}
              {token && (
                <Pill mono title="API token">
                  !{token}
                </Pill>
              )}
            </span>
          );
        },
      },
      {
        key: 'started',
        header: 'Started',
        hideBelow: 'iphone',
        sortValue: (t) => t.startTime,
        defaultDir: 'desc',
        cell: (t) => (
          <span className="t-label-2" title={formatFullDateTime(t.startTime)}>
            <RelativeTime time={t.startTime} format="short" />
          </span>
        ),
      },
      {
        key: 'duration',
        header: 'Duration',
        align: 'right',
        hideBelow: 'iphone',
        sortValue: (t) => taskDurationMs(t, now),
        cell: (t) => <span className="t-num">{formatTaskDuration(taskDurationMs(t, now))}</span>,
      },
      {
        key: 'status',
        header: 'Status',
        align: 'right',
        sortValue: (t) => SEVERITY_RANK[t.severity],
        cell: (t) => (
          <span className="tasks-status" title={t.status}>
            <StatusBadge {...toneOf.task(t.severity)} size="small" spinning={t.severity === 'running'} />
          </span>
        ),
      },
    ],
    [lookup, now],
  );

  const subtitle = [
    plural(tasks.length, 'recent task'),
    counts.running ? `${counts.running} running` : '',
    counts.error ? `${counts.error} failed` : '',
    counts.warning ? plural(counts.warning, 'with warnings', 'with warnings') : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <PageHeader title="Tasks" subtitle={subtitle} />
      <div className="inf-page" style={{ gap: 'var(--s4)' }}>
        <FilterBar>
          <SegmentedControl ariaLabel="Show" options={FILTERS} value={filter} onChange={(v) => setQuery({ filter: v === 'all' ? null : v })} />
          <SelectField ariaLabel="Task type" value={type} options={types} onChange={(v) => setQuery({ type: v || null })} />
        </FilterBar>

        <Card padding="none" className="tasks-card">
          {tasks.length === 0 ? (
            <EmptyState
              className="tasks-empty"
              icon={<ListChecks size={26} strokeWidth={1.8} />}
              title="No tasks yet"
              message="Backups, starts, consoles and other Proxmox jobs show up here as soon as they run."
            />
          ) : rows.length === 0 ? (
            <EmptyFiltered filter={filter} type={type} />
          ) : (
            <Table caption="Recent Proxmox tasks" columns={columns} rows={rows} rowKey={(t) => t.upid} onRowClick={openTask} />
          )}
        </Card>
      </div>
      <TaskLogSheet task={selected} onClose={closeTask} />
    </>
  );
}

function EmptyFiltered({ filter, type }: { filter: TaskFilter; type: string }) {
  const what = type ? `${taskTypeLabel(type).toLowerCase()} ` : '';
  if (filter === 'errors') {
    return (
      <EmptyState
        className="tasks-empty"
        tone="ok"
        icon={<CircleCheck size={26} strokeWidth={1.8} />}
        title="No failed tasks"
        message={`Every recent ${what}task finished without errors or warnings.`}
      />
    );
  }
  if (filter === 'running') {
    return <EmptyState className="tasks-empty" icon={<LoaderCircle size={26} strokeWidth={1.8} />} title="Nothing running" message={`No ${what}task is running right now.`} />;
  }
  return <EmptyState className="tasks-empty" icon={<ListChecks size={26} strokeWidth={1.8} />} title="No matching tasks" message="Try another task type." />;
}
